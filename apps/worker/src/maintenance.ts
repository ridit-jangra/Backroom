import { EMOJI_DAY_KEY_PREFIX } from './emoji/custom';

/** Used or expired sign-in tokens and desktop codes are kept this long before the daily cron removes them. */
export const AUTH_ROW_GRACE_MS = 86_400_000;
/** Rate-limit windows are at most 1 h long; a row whose window started over 2 h ago no longer limits anything. */
export const RATE_LIMIT_KEEP_MS = 7_200_000;
/** Per-UTC-day counters (`emoji:day:*`, P6-R10) must outlive their whole day, so they are kept 2 days. */
export const DAILY_LIMIT_KEEP_MS = 172_800_000;

/**
 * Daily D1-only cleanup (Phase 6): login_tokens and desktop_codes that expired, or were used, more than
 * AUTH_ROW_GRACE_MS ago, rate_limits windows older than RATE_LIMIT_KEEP_MS (daily counters older than
 * DAILY_LIMIT_KEEP_MS). Never touches blob storage.
 */
export async function cleanupAuth(
  db: D1Database,
  now: number,
): Promise<{ loginTokens: number; desktopCodes: number; rateLimits: number }> {
  const cutoff = now - AUTH_ROW_GRACE_MS;
  const [tokens, codes, limits] = await db.batch([
    db.prepare('DELETE FROM login_tokens WHERE expires_at < ?1 OR (used_at IS NOT NULL AND used_at < ?1)').bind(cutoff),
    db.prepare('DELETE FROM desktop_codes WHERE expires_at < ?1 OR (used_at IS NOT NULL AND used_at < ?1)').bind(cutoff),
    db
      .prepare(`DELETE FROM rate_limits WHERE window_start < ?1 AND (key NOT LIKE '${EMOJI_DAY_KEY_PREFIX}%' OR window_start < ?2)`)
      .bind(now - RATE_LIMIT_KEEP_MS, now - DAILY_LIMIT_KEEP_MS),
  ]);
  const out = {
    loginTokens: tokens!.meta.changes,
    desktopCodes: codes!.meta.changes,
    rateLimits: limits!.meta.changes,
  };
  console.info(JSON.stringify({ level: 'info', code: 'auth_cleaned', ...out }));
  return out;
}
