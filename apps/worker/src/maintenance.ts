/** Used or expired sign-in tokens and desktop codes are kept this long before the daily cron removes them. */
export const AUTH_ROW_GRACE_MS = 86_400_000;
/** Rate-limit windows are at most 1 h long; a row whose window started over 2 h ago no longer limits anything. */
export const RATE_LIMIT_KEEP_MS = 7_200_000;

/**
 * Daily D1-only cleanup (Phase 6): login_tokens and desktop_codes that expired, or were used, more than
 * AUTH_ROW_GRACE_MS ago, and rate_limits windows older than RATE_LIMIT_KEEP_MS. Never touches R2.
 */
export async function cleanupAuth(
  db: D1Database,
  now: number,
): Promise<{ loginTokens: number; desktopCodes: number; rateLimits: number }> {
  const cutoff = now - AUTH_ROW_GRACE_MS;
  const [tokens, codes, limits] = await db.batch([
    db.prepare('DELETE FROM login_tokens WHERE expires_at < ?1 OR (used_at IS NOT NULL AND used_at < ?1)').bind(cutoff),
    db.prepare('DELETE FROM desktop_codes WHERE expires_at < ?1 OR (used_at IS NOT NULL AND used_at < ?1)').bind(cutoff),
    db.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(now - RATE_LIMIT_KEEP_MS),
  ]);
  const out = {
    loginTokens: tokens!.meta.changes,
    desktopCodes: codes!.meta.changes,
    rateLimits: limits!.meta.changes,
  };
  console.info(JSON.stringify({ level: 'info', code: 'auth_cleaned', ...out }));
  return out;
}
