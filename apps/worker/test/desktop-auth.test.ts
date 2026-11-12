import { env } from 'cloudflare:test';
import { beforeEach, it, expect } from 'vitest';
import { createApp } from '../src/app';
import { captureMailer, post, resetDb, seedUsers, send, testDeps } from './helpers';

beforeEach(resetDb);

const VERIFIER = 'A'.repeat(43);
async function challengeOf(v: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)));
  let s = '';
  for (const b of d) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const tokenOf = (url: string) => new URL(url).searchParams.get('t')!;
const errCode = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;

function setup(now?: () => number) {
  const { mailer, sent } = captureMailer();
  const app = createApp(testDeps({ mailer, ...(now ? { now } : {}) }));
  return { app, sent };
}

async function desktopVerify(app: ReturnType<typeof setup>['app'], sent: { url: string }[], verifier = VERIFIER) {
  await post(app, '/auth/start', { email: 'owner@test.dev', desktopChallenge: await challengeOf(verifier) });
  return post(app, '/auth/verify', { token: tokenOf(sent[sent.length - 1]!.url) });
}
async function getCode(app: ReturnType<typeof setup>['app'], sent: { url: string }[]) {
  const res = await desktopVerify(app, sent);
  return ((await res.json()) as { desktopCode: string }).desktopCode;
}

it('start with desktopChallenge then verify returns desktopCode and sets no Set-Cookie', async () => {
  const { app, sent } = setup();
  const res = await desktopVerify(app, sent);
  expect(res.status).toBe(200);
  expect(res.headers.get('Set-Cookie')).toBeNull();
  const body = (await res.json()) as { ok: boolean; workspace: string; desktopCode: string };
  expect(body.ok).toBe(true);
  expect(body.workspace).toBe('clubhack');
  expect(body.desktopCode.length).toBeGreaterThanOrEqual(10);
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first<{ n: number }>();
  expect(n!.n).toBe(0);
});

it("exchange with correct verifier sets backroom_session cookie and returns workspace 'clubhack'", async () => {
  const { app, sent } = setup();
  const code = await getCode(app, sent);
  const res = await post(app, '/auth/desktop/exchange', { code, verifier: VERIFIER });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, workspace: 'clubhack' });
  expect(res.headers.get('Set-Cookie')).toContain('backroom_session=');
});

it('exchange with wrong verifier -> 400 code_invalid, and code is burned', async () => {
  const { app, sent } = setup();
  const code = await getCode(app, sent);
  const bad = await post(app, '/auth/desktop/exchange', { code, verifier: 'B'.repeat(43) });
  expect(bad.status).toBe(400);
  expect(await errCode(bad)).toBe('code_invalid');
  const burned = await env.DB.prepare('SELECT used_at FROM desktop_codes').first<{ used_at: number | null }>();
  expect(burned!.used_at).not.toBeNull();
  const good = await post(app, '/auth/desktop/exchange', { code, verifier: VERIFIER });
  expect(good.status).toBe(400);
  expect(await errCode(good)).toBe('code_invalid');
});

it('exchange after 120 000 ms -> 400 code_invalid', async () => {
  let now = 1_800_000_000_000;
  const { app, sent } = setup(() => now);
  const early = await getCode(app, sent);
  now += 119_999;
  expect((await post(app, '/auth/desktop/exchange', { code: early, verifier: VERIFIER })).status).toBe(200);
  now -= 119_999;
  const code = await getCode(app, sent);
  now += 120_000;
  const res = await post(app, '/auth/desktop/exchange', { code, verifier: VERIFIER });
  expect(res.status).toBe(400);
  expect(await errCode(res)).toBe('code_invalid');
});

it('replayed code -> 400 code_invalid', async () => {
  const { app, sent } = setup();
  const code = await getCode(app, sent);
  expect((await post(app, '/auth/desktop/exchange', { code, verifier: VERIFIER })).status).toBe(200);
  const again = await post(app, '/auth/desktop/exchange', { code, verifier: VERIFIER });
  expect(again.status).toBe(400);
  expect(await errCode(again)).toBe('code_invalid');
});

it('deactivated member -> 400 code_invalid on exchange', async () => {
  const { app, sent } = setup();
  const ok = await post(app, '/auth/desktop/exchange', { code: await getCode(app, sent), verifier: VERIFIER });
  expect(ok.status).toBe(200);
  const code = await getCode(app, sent);
  await env.DB.prepare('UPDATE workspace_members SET deactivated_at = 1').run();
  const res = await post(app, '/auth/desktop/exchange', { code, verifier: VERIFIER });
  expect(res.status).toBe(400);
  expect(await errCode(res)).toBe('code_invalid');
  expect(res.headers.get('Set-Cookie')).toBeNull();
});

it('desktop verify that fails eligibility returns 403 and inserts no desktop_codes row', async () => {
  const { app, sent } = setup();
  const [owner] = await seedUsers(app, sent, ['owner@test.dev']);
  const inv = await send(app, 'POST', '/w/clubhack/invites', { maxUses: 1 }, owner!.cookie);
  const inviteToken = ((await inv.json()) as { url: string }).url.split('/invite/')[1]!;
  await post(app, '/auth/start', { email: 'guest@test.dev', inviteToken, desktopChallenge: await challengeOf(VERIFIER) });
  await env.DB.prepare('UPDATE invites SET expires_at = 1').run();
  const res = await post(app, '/auth/verify', { token: tokenOf(sent[sent.length - 1]!.url) });
  expect(res.status).toBe(403);
  expect(await errCode(res)).toBe('not_allowed');
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM desktop_codes').first<{ n: number }>();
  expect(n!.n).toBe(0);
});

it('non-desktop verify unchanged: cookie set, no desktopCode', async () => {
  const { app, sent } = setup();
  await post(app, '/auth/start', { email: 'owner@test.dev' });
  const res = await post(app, '/auth/verify', { token: tokenOf(sent[0]!.url) });
  expect(res.headers.get('Set-Cookie')).toContain('backroom_session=');
  expect(await res.json()).toEqual({ ok: true, workspace: 'clubhack' });
});

it('malformed desktopChallenge -> 400 invalid_request', async () => {
  const { app } = setup();
  for (const desktopChallenge of ['short', 'A'.repeat(44), '!'.repeat(43)]) {
    const res = await post(app, '/auth/start', { email: 'owner@test.dev', desktopChallenge });
    expect(res.status).toBe(400);
    expect(await errCode(res)).toBe('invalid_request');
  }
});

it('exchange requires same Origin', async () => {
  const { app, sent } = setup();
  const code = await getCode(app, sent);
  const res = await post(app, '/auth/desktop/exchange', { code, verifier: VERIFIER }, { Origin: 'https://evil.test' });
  expect(res.status).toBe(403);
  expect(await errCode(res)).toBe('bad_origin');
});

it('cookie has Secure only when APP_ORIGIN starts with https:', async () => {
  const { app, sent } = setup();
  const https = await post(app, '/auth/desktop/exchange', { code: await getCode(app, sent), verifier: VERIFIER });
  expect(https.headers.get('Set-Cookie')).toContain('Secure');

  const e = env as { APP_ORIGIN: string };
  const orig = e.APP_ORIGIN;
  const origin = { Origin: 'http://localhost:8787' };
  try {
    e.APP_ORIGIN = origin.Origin;
    await post(app, '/auth/start', { email: 'owner@test.dev', desktopChallenge: await challengeOf(VERIFIER) }, origin);
    const v = await post(app, '/auth/verify', { token: tokenOf(sent[sent.length - 1]!.url) }, origin);
    const { desktopCode } = (await v.json()) as { desktopCode: string };
    const http = await post(app, '/auth/desktop/exchange', { code: desktopCode, verifier: VERIFIER }, origin);
    expect(http.status).toBe(200);
    const cookie = http.headers.get('Set-Cookie')!;
    expect(cookie).toContain('backroom_session=');
    expect(cookie).not.toContain('Secure');
  } finally {
    e.APP_ORIGIN = orig;
  }
});
