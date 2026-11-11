import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { createSession, resolveSession, SESSION_TTL_MS } from '../src/auth/sessions';
import { requireSession } from '../src/middleware/session';
import { testDeps } from './helpers';

const WS = '01JCLUBHACK0000000000000WS';
const USER = '01JUSER00000000000000000001';
const now = 1_800_000_000_000;
const DAY = 86_400_000;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions'),
    env.DB.prepare('DELETE FROM workspace_members WHERE user_id = ?').bind(USER),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(USER),
    env.DB.prepare('INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)').bind(USER, 'u@example.com', 'U', now),
    env.DB.prepare('INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)').bind(WS, USER, 'member', now),
  ]);
});

describe('sessions', () => {
  it('creates and resolves a session', async () => {
    const t = await createSession(env.DB, USER, 'UA', now);
    expect(await resolveSession(env.DB, t, now)).toEqual({ userId: USER, renewed: false });
    const row = await env.DB.prepare('SELECT count(*) AS n FROM sessions WHERE token_hash = ?').bind(t).first<{ n: number }>();
    expect(row!.n).toBe(0);
  });

  it('expired session resolves to null', async () => {
    const t = await createSession(env.DB, USER, null, now);
    expect(await resolveSession(env.DB, t, now + SESSION_TTL_MS + 1)).toBeNull();
  });

  it('renews when under 15 days remain', async () => {
    const t = await createSession(env.DB, USER, null, now);
    const later = now + 16 * DAY;
    expect(await resolveSession(env.DB, t, later)).toEqual({ userId: USER, renewed: true });
    const row = await env.DB.prepare('SELECT expires_at FROM sessions').first<{ expires_at: number }>();
    expect(row!.expires_at).toBe(later + SESSION_TTL_MS);
  });

  it('deactivated member session is rejected', async () => {
    const t = await createSession(env.DB, USER, null, now);
    await env.DB.prepare('UPDATE workspace_members SET deactivated_at = ? WHERE user_id = ?').bind(now, USER).run();
    expect(await resolveSession(env.DB, t, now)).toBeNull();
  });

  it('requireSession returns 401 without credentials, 200 with Bearer', async () => {
    const app = createApp(testDeps());
    app.get('/w/x/me-probe', requireSession, (c) => c.json({ ok: true }));
    const res = await app.request('/w/x/me-probe', {}, env);
    expect(res.status).toBe(401);
    const t = await createSession(env.DB, USER, null, now);
    const ok = await app.request('/w/x/me-probe', { headers: { Authorization: `Bearer ${t}` } }, env);
    expect(ok.status).toBe(200);
  });
});
