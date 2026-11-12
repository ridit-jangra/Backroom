import { Hono } from 'hono';
import { AuthStartBody, AuthVerifyBody, DesktopExchangeBody } from '@backroom/protocol';
import type { AppEnv } from '../app';
import { ApiError } from '../lib/errors';
import { randomToken, sha256Hex } from '../lib/crypto';
import { readJson } from '../lib/http';
import { hitRateLimit } from '../lib/rateLimit';
import { checkEligibility, checkEligibilityByInviteId } from './eligibility';
import { createSession, deleteAllSessions, deleteSession } from './sessions';
import { acceptLogin, WORKSPACE_SLUG } from '../workspace/membership';
import { clearSessionCookie, requireSession, setSessionCookie } from '../middleware/session';

const HOUR_MS = 3_600_000;
const LINK_TTL_MS = 900_000;
const DESKTOP_CODE_TTL_MS = 120_000;

async function sha256Base64Url(input: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)));
  let s = '';
  for (const b of digest) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const authRoutes = new Hono<AppEnv>();

authRoutes.post('/start', async (c) => {
  const { email, inviteToken, desktopChallenge } = AuthStartBody.parse(await readJson(c));
  const { now: nowFn, mailer } = c.var.deps;
  const now = nowFn();
  const db = c.env.DB;
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';

  const emailOk = await hitRateLimit(db, `start:email:${email}`, 5, HOUR_MS, now);
  const ipOk = await hitRateLimit(db, `start:ip:${ip}`, 20, HOUR_MS, now);
  if (emailOk && ipOk) {
    const elig = await checkEligibility(db, email, inviteToken, c.env.OWNER_EMAIL, now);
    if (elig.ok) {
      // Token creation, hashing, insert and send all run off the response path so timing
      // does not reveal allowlist membership.
      const raw = randomToken();
      const inviteId = elig.inviteId;
      const send = (async () => {
        try {
          await db
            .prepare('INSERT INTO login_tokens (token_hash, email, invite_id, expires_at, desktop_challenge) VALUES (?, ?, ?, ?, ?)',
            )
            .bind(await sha256Hex(raw), email, inviteId, now + LINK_TTL_MS, desktopChallenge ?? null)
            .run();
        } catch {
          console.error(JSON.stringify({ level: 'error', code: 'login_token_failed' }));
          return;
        }
        try {
          await mailer.sendMagicLink(c.env, email, `${c.env.APP_ORIGIN}/verify?t=${raw}`);
        } catch {
          console.error(JSON.stringify({ level: 'error', code: 'email_failed' }));
        }
      })();
      let ctx: { waitUntil(p: Promise<unknown>): void } | undefined;
      try {
        ctx = c.executionCtx;
      } catch {
        ctx = undefined;
      }
      if (ctx) ctx.waitUntil(send);
      else await send;
    }
  }
  return c.json({ ok: true });
});

authRoutes.post('/verify', async (c) => {
  const { token } = AuthVerifyBody.parse(await readJson(c));
  const now = c.var.deps.now();
  const db = c.env.DB;
  const row = await db
    .prepare(
      'UPDATE login_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING email, invite_id, desktop_challenge',
    )
    .bind(now, await sha256Hex(token), now)
    .first<{ email: string; invite_id: string | null; desktop_challenge: string | null }>();
  if (!row) throw new ApiError(400, 'link_invalid', 'This sign-in link is invalid, expired or already used.');

  const elig = await checkEligibilityByInviteId(db, row.email, row.invite_id, c.env.OWNER_EMAIL, now);
  if (!elig.ok) throw new ApiError(403, 'not_allowed', 'This email is not allowed to join.');

  const { userId } = await acceptLogin(db, row.email, elig.inviteId, c.env.OWNER_EMAIL, now);
  if (row.desktop_challenge) {
    const code = randomToken();
    await db
      .prepare('INSERT INTO desktop_codes (code_hash, user_id, challenge, expires_at) VALUES (?, ?, ?, ?)')
      .bind(await sha256Hex(code), userId, row.desktop_challenge, now + DESKTOP_CODE_TTL_MS)
      .run();
    return c.json({ ok: true, workspace: WORKSPACE_SLUG, desktopCode: code });
  }
  const session = await createSession(db, userId, c.req.header('User-Agent') ?? null, now);
  setSessionCookie(c, session);
  return c.json({ ok: true, workspace: WORKSPACE_SLUG });
});

authRoutes.post('/desktop/exchange', async (c) => {
  const { code, verifier } = DesktopExchangeBody.parse(await readJson(c));
  const now = c.var.deps.now();
  const db = c.env.DB;
  const invalid = () => new ApiError(400, 'code_invalid', 'This sign-in code is invalid or expired.');
  const row = await db
    .prepare(
      'UPDATE desktop_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING user_id, challenge',
    )
    .bind(now, await sha256Hex(code), now)
    .first<{ user_id: string; challenge: string }>();
  if (!row) throw invalid();
  if (!constantTimeEqual(await sha256Base64Url(verifier), row.challenge)) throw invalid();
  const member = await db
    .prepare(
      'SELECT 1 AS ok FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id WHERE wm.user_id = ? AND w.slug = ? AND wm.deactivated_at IS NULL',
    )
    .bind(row.user_id, WORKSPACE_SLUG)
    .first();
  if (!member) throw invalid();
  const session = await createSession(db, row.user_id, c.req.header('User-Agent') ?? null, now);
  setSessionCookie(c, session);
  return c.json({ ok: true, workspace: WORKSPACE_SLUG });
});

authRoutes.post('/logout', async (c) => {
  if (c.var.session) await deleteSession(c.env.DB, c.var.session.token);
  clearSessionCookie(c);
  return c.json({ ok: true });
});

authRoutes.post('/logout-all', requireSession, async (c) => {
  await deleteAllSessions(c.env.DB, c.var.session!.userId);
  clearSessionCookie(c);
  return c.json({ ok: true });
});
