import { ORPHAN_TTL_MS } from '@backroom/protocol';
import type { Env } from '../env';
import { FILE_KEY_RE } from './store';

export const ORPHAN_BATCH = 100;
export const ORPHAN_MAX_BATCHES = 10;

type Row = { key: string; thumbKey: string | null };

/**
 * Removes files nobody linked to a message within ORPHAN_TTL_MS (never attached, or their message was
 * deleted). D1 first, then R2 with the keys D1 returned (stored r2_key/thumb_key, guarded by FILE_KEY_RE).
 * Attach refuses files this old (P4-R8), so a valid attach cannot race the removal.
 * At most ORPHAN_BATCH * ORPHAN_MAX_BATCHES rows per run.
 */
export async function cleanupOrphans(env: Env, now: number): Promise<{ deleted: number; keysRejected: number }> {
  let deleted = 0;
  let keysRejected = 0;
  for (let i = 0; i < ORPHAN_MAX_BATCHES; i++) {
    const { results } = await env.DB.prepare(
      `DELETE FROM files WHERE id IN (
         SELECT f.id FROM files f
         WHERE f.created_at < ?1 AND NOT EXISTS (SELECT 1 FROM message_files mf WHERE mf.file_id = f.id)
         ORDER BY f.created_at LIMIT ?2)
       RETURNING r2_key AS key, thumb_key AS thumbKey`,
    )
      .bind(now - ORPHAN_TTL_MS, ORPHAN_BATCH)
      .all<Row>();
    deleted += results.length;

    const candidates = results.flatMap((r) => (r.thumbKey ? [r.key, r.thumbKey] : [r.key]));
    const keys = candidates.filter((k) => FILE_KEY_RE.test(k));
    if (keys.length < candidates.length) {
      keysRejected += candidates.length - keys.length;
      console.warn(JSON.stringify({ level: 'warn', code: 'orphan_key_rejected' }));
    }
    if (keys.length > 0) {
      try {
        await env.BUCKET.delete(keys);
      } catch {
        console.error(JSON.stringify({ level: 'error', code: 'orphan_r2_delete_failed' }));
      }
    }
    if (results.length < ORPHAN_BATCH) break;
  }
  console.info(JSON.stringify({ level: 'info', code: 'orphans_cleaned', deleted }));
  return { deleted, keysRejected };
}
