import { env } from 'cloudflare:test';
import { beforeEach, it, expect } from 'vitest';
import { createApp } from '../src/app';
import { captureMailer, post, signIn, testDeps } from './helpers';

beforeEach(async () => {
  await env.DB.batch(
    ['rate_limits', 'login_tokens', 'sessions', 'channel_members', 'workspace_members', 'users'].map((t) =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
});

function setup(now?: () => number) {
  const { mailer, sent } = captureMailer();
  const app = createApp(testDeps({ mailer, ...(now ? { now } : {}) }));
  return { app, sent };
}
const tokenOf = (url: string) => new URL(url).searchParams.get('t')!;
const count = async (table: string) =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;

it('start for eligible email sends one link; ineligible sends none; both return 200 {ok:true}', async () => {
  const { app, sent } = setup();
  const a = await post(app, '/auth/start', { email: 'owner@test.dev' });
  expect(a.status).toBe(200);
  expect(await a.json()).toEqual({ ok: true });
  const b = await post(app, '/auth/start', { email: 'stranger@test.dev' });
  expect(b.status).toBe(200);
  expect(await b.json()).toEqual({ ok: true });
  expect(sent).toHaveLength(1);
  expect(sent[0]!.to).toBe('owner@test.dev');
  expect(sent[0]!.url.startsWith('https://app.test/verify?t=')).toBe(true);
});

it('start normalizes email', async () => {
  const { app, sent } = setup();
  await post(app, '/auth/start', { email: ' Owner@Test.DEV ' });
  expect(sent.map((s) => s.to)).toEqual(['owner@test.dev']);
});

it('start is rate limited per email', async () => {
  const { app, sent } = setup();
  for (let i = 0; i < 6; i++) {
    const res = await post(app, '/auth/start', { email: 'owner@test.dev' });
    expect(res.status).toBe(200);
  }
  expect(sent).toHaveLength(5);
});

it('start swallows mailer failures and still returns 200', async () => {
  const app = createApp(testDeps({ mailer: { sendMagicLink: async () => { throw new Error('boom'); } } }));
  const res = await post(app, '/auth/start', { email: 'owner@test.dev' });
  expect(res.status).toBe(200);
});

it('verify page link is not consumed by GET', async () => {
  const { app, sent } = setup();
  await post(app, '/auth/start', { email: 'owner@test.dev' });
  const t = tokenOf(sent[0]!.url);
  await app.request(`/verify?t=${t}`, {}, env);
  const res = await post(app, '/auth/verify', { token: t });
  expect(res.status).toBe(200);
});

it('verify sets session cookie and creates owner', async () => {
  const { app, sent } = setup();
  await post(app, '/auth/start', { email: 'owner@test.dev' });
  const res = await post(app, '/auth/verify', { token: tokenOf(sent[0]!.url) });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, workspace: 'clubhack' });
  const cookie = res.headers.get('Set-Cookie')!;
  expect(cookie).toContain('backroom_session=');
  expect(cookie).toContain('HttpOnly');
  expect(cookie).toContain('Secure');
  expect(cookie).toContain('SameSite=Lax');
  expect(await count('sessions')).toBe(1);
  const m = await env.DB.prepare('SELECT role FROM workspace_members').first<{ role: string }>();
  expect(m!.role).toBe('owner');
});

it('verify rejects reuse', async () => {
  const { app, sent } = setup();
  await post(app, '/auth/start', { email: 'owner@test.dev' });
  const t = tokenOf(sent[0]!.url);
  await post(app, '/auth/verify', { token: t });
  const res = await post(app, '/auth/verify', { token: t });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe('link_invalid');
});

it('concurrent verify creates one session', async () => {
  const { app, sent } = setup();
  await post(app, '/auth/start', { email: 'owner@test.dev' });
  const t = tokenOf(sent[0]!.url);
  const rs = await Promise.all([post(app, '/auth/verify', { token: t }), post(app, '/auth/verify', { token: t })]);
  expect(rs.map((r) => r.status).sort()).toEqual([200, 400]);
  expect(await count('sessions')).toBe(1);
});

it('verify rejects expired token', async () => {
  let now = 1_800_000_000_000;
  const { app, sent } = setup(() => now);
  await post(app, '/auth/start', { email: 'owner@test.dev' });
  now += 900_001;
  const res = await post(app, '/auth/verify', { token: tokenOf(sent[0]!.url) });
  expect(res.status).toBe(400);
});

it('logout clears cookie and session', async () => {
  const { app, sent } = setup();
  const cookie = await signIn(app, sent, 'owner@test.dev');
  const res = await post(app, '/auth/logout', {}, { Cookie: cookie });
  expect(res.status).toBe(200);
  expect(res.headers.get('Set-Cookie')).toContain('Max-Age=0');
  expect(await count('sessions')).toBe(0);
});

it('logout requires a session', async () => {
  const { app } = setup();
  const res = await post(app, '/auth/logout', {});
  expect(res.status).toBe(401);
});

it('logout-all ends every session', async () => {
  const { app, sent } = setup();
  const c1 = await signIn(app, sent, 'owner@test.dev');
  await signIn(app, sent, 'owner@test.dev');
  expect(await count('sessions')).toBe(2);
  const res = await post(app, '/auth/logout-all', {}, { Cookie: c1 });
  expect(res.status).toBe(200);
  expect(await count('sessions')).toBe(0);
});

it('start without Origin is 403', async () => {
  const { app } = setup();
  const res = await app.request('/auth/start', { method: 'POST', body: '{}' }, env);
  expect(res.status).toBe(403);
});

it('malformed JSON body is 400 invalid_request', async () => {
  const { app } = setup();
  const raw = await app.request(
    '/auth/start',
    { method: 'POST', headers: { Origin: 'https://app.test', 'Content-Type': 'application/json' }, body: '{not json' },
    env,
  );
  expect(raw.status).toBe(400);
  expect(((await raw.json()) as { error: { code: string } }).error.code).toBe('invalid_request');
});
