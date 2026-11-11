/** Fixed-window limiter. Returns true when the hit is allowed. */
export async function hitRateLimit(
  db: D1Database,
  key: string,
  limit: number,
  windowMs: number,
  now: number,
): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT(key) DO UPDATE SET
         window_start = CASE WHEN ?2 - window_start >= ?3 THEN ?2 ELSE window_start END,
         count = CASE WHEN ?2 - window_start >= ?3 THEN 1 ELSE count + 1 END
       RETURNING count`,
    )
    .bind(key, now, windowMs)
    .first<{ count: number }>();
  return (row?.count ?? Infinity) <= limit;
}
