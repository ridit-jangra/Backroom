import { randomToken, sha256Hex } from '../lib/crypto';

export const SESSION_COOKIE = 'backroom_session';
export const SESSION_TTL_MS = 30 * 86_400_000;
export const SESSION_RENEW_BELOW_MS = 15 * 86_400_000;

export type SessionInfo = { userId: string; token: string };

export async function createSession(
  db: D1Database,
  userId: string,
  userAgent: string | null,
  now: number,
): Promise<string> {
  const token = randomToken();
  const hash = await sha256Hex(token);
  await db
    .prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)')
    .bind(hash, userId, now, now + SESSION_TTL_MS, userAgent)
    .run();
  return token;
}

export async function resolveSession(
  db: D1Database,
  token: string,
  now: number,
): Promise<{ userId: string; renewed: boolean } | null> {
  const hash = await sha256Hex(token);
  const row = await db
    .prepare(
      `SELECT s.user_id AS user_id, s.expires_at AS expires_at FROM sessions s
       WHERE s.token_hash = ? AND s.expires_at > ?
         AND EXISTS (SELECT 1 FROM workspace_members m WHERE m.user_id = s.user_id AND m.deactivated_at IS NULL)`,
    )
    .bind(hash, now)
    .first<{ user_id: string; expires_at: number }>();
  if (!row) return null;
  let renewed = false;
  if (row.expires_at - now < SESSION_RENEW_BELOW_MS) {
    await db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').bind(now + SESSION_TTL_MS, hash).run();
    renewed = true;
  }
  return { userId: row.user_id, renewed };
}

export async function deleteSession(db: D1Database, token: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
}

export async function deleteAllSessions(db: D1Database, userId: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
}
