import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import type { Bootstrap } from '@backroom/protocol';
import { createApp } from '../src/app';
import type { Mailer } from '../src/auth/mailer';
import { captureMailer, post, resetDb, seedUsers, send, signIn, testDeps } from './helpers';

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const errBody = async (r: Response) => ((await r.json()) as { error: { code: string; message: string } }).error;

describe('/auth/desktop/exchange rate limit', () => {
  it('allows 30 attempts per hour per IP, then 429 rate_limited', async () => {
    let now = 1_800_000_000_000;
    const app = createApp(testDeps({ now: () => now }));
    const ip = { 'CF-Connecting-IP': '203.0.113.7' };
    const body = { code: 'nope-nope-nope', verifier: 'A'.repeat(43) };
    for (let i = 0; i < 30; i++) {
      const r = await post(app, '/auth/desktop/exchange', body, ip);
      expect(r.status).toBe(400); // code_invalid, but counted
    }
    const over = await post(app, '/auth/desktop/exchange', body, ip);
    expect(over.status).toBe(429);
    expect(await errBody(over)).toEqual({ code: 'rate_limited', message: 'Too many attempts. Try again later.' });
    // another IP is unaffected
    expect((await post(app, '/auth/desktop/exchange', body, { 'CF-Connecting-IP': '203.0.113.8' })).status).toBe(400);
    // the window resets after an hour
    now += 3_600_000;
    expect((await post(app, '/auth/desktop/exchange', body, ip)).status).toBe(400);
  });

  it('a rate-limited exchange does not consume a valid code', async () => {
    const { mailer, sent } = captureMailer();
    const app = createApp(testDeps({ mailer }));
    const ip = { 'CF-Connecting-IP': '203.0.113.9' };
    const verifier = 'A'.repeat(43);
    const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const challenge = btoa(String.fromCharCode(...d)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await post(app, '/auth/start', { email: 'owner@test.dev', desktopChallenge: challenge });
    const v = await post(app, '/auth/verify', { token: new URL(sent[0]!.url).searchParams.get('t')! });
    const { desktopCode } = (await v.json()) as { desktopCode: string };
    for (let i = 0; i < 30; i++) await post(app, '/auth/desktop/exchange', { code: 'x'.repeat(20), verifier }, ip);
    expect((await post(app, '/auth/desktop/exchange', { code: desktopCode, verifier }, ip)).status).toBe(429);
    const row = await env.DB.prepare('SELECT used_at FROM desktop_codes').first<{ used_at: number | null }>();
    expect(row!.used_at).toBeNull();
  });
});

describe('logout headers', () => {
  it('/auth/logout sends Clear-Site-Data', async () => {
    const { mailer, sent } = captureMailer();
    const app = createApp(testDeps({ mailer }));
    const cookie = await signIn(app, sent, 'owner@test.dev');
    const r = await post(app, '/auth/logout', {}, { Cookie: cookie });
    expect(r.status).toBe(200);
    expect(r.headers.get('Clear-Site-Data')).toBe('"cache", "storage"');
    const anon = await post(app, '/auth/logout', {});
    expect(anon.headers.get('Clear-Site-Data')).toBe('"cache", "storage"');
  });

  it('/auth/logout-all sends Clear-Site-Data', async () => {
    const { mailer, sent } = captureMailer();
    const app = createApp(testDeps({ mailer }));
    const cookie = await signIn(app, sent, 'owner@test.dev');
    const r = await post(app, '/auth/logout-all', {}, { Cookie: cookie });
    expect(r.status).toBe(200);
    expect(r.headers.get('Clear-Site-Data')).toBe('"cache", "storage"');
  });
});

describe('email-failure signal (R11)', () => {
  const T = 1_800_000_000_000;
  const failing: Mailer = {
    async sendMagicLink() {
      throw new Error('boom');
    },
  };
  const opsRow = () => env.DB.prepare("SELECT kind, at FROM ops_events WHERE kind = 'email_failed'").first<{ kind: string; at: number }>();

  it('a mailer failure upserts (email_failed, now); the response is unchanged', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let now = T;
    const app = createApp(testDeps({ mailer: failing, now: () => now }));
    const r = await post(app, '/auth/start', { email: 'owner@test.dev' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(await opsRow()).toEqual({ kind: 'email_failed', at: T });
    now = T + 5_000;
    await post(app, '/auth/start', { email: 'owner@test.dev' });
    expect(await opsRow()).toEqual({ kind: 'email_failed', at: T + 5_000 });
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM ops_events').first<{ n: number }>();
    expect(n!.n).toBe(1);
  });

  it('an ineligible email never records anything (no mail attempted)', async () => {
    const app = createApp(testDeps({ mailer: failing }));
    await post(app, '/auth/start', { email: 'stranger@test.dev' });
    expect(await opsRow()).toBeNull();
  });

  it('a successful send records nothing', async () => {
    const { mailer } = captureMailer();
    const app = createApp(testDeps({ mailer }));
    await post(app, '/auth/start', { email: 'owner@test.dev' });
    expect(await opsRow()).toBeNull();
  });

  it('an ops_events write failure is swallowed and logged by code', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const realPrepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes('ops_events')) throw new Error('d1 down');
      return realPrepare(sql);
    });
    const app = createApp(testDeps({ mailer: failing }));
    const r = await post(app, '/auth/start', { email: 'owner@test.dev' });
    expect(r.status).toBe(200);
    expect(err).toHaveBeenCalledWith(JSON.stringify({ level: 'error', code: 'email_failed' }));
    expect(err).toHaveBeenCalledWith(JSON.stringify({ level: 'error', code: 'ops_event_failed' }));
  });

  it('bootstrap returns emailFailedAt to admins and owners only', async () => {
    const { mailer, sent } = captureMailer();
    const app = createApp(testDeps({ mailer }));
    const [owner, alice] = await seedUsers(app, sent, ['owner@test.dev', 'alice@test.dev']);
    const boot = async (cookie: string) =>
      (await (await send(app, 'GET', '/w/clubhack/bootstrap', undefined, cookie)).json()) as Bootstrap;
    expect('emailFailedAt' in (await boot(owner!.cookie))).toBe(false);
    await env.DB.prepare("INSERT INTO ops_events (kind, at) VALUES ('email_failed', ?)").bind(T - 1_000).run();
    expect((await boot(owner!.cookie)).emailFailedAt).toBe(T - 1_000);
    expect('emailFailedAt' in (await boot(alice!.cookie))).toBe(false);
    await send(app, 'PATCH', `/w/clubhack/members/${alice!.userId}`, { role: 'admin' }, owner!.cookie);
    expect((await boot(alice!.cookie)).emailFailedAt).toBe(T - 1_000);
  });
});
