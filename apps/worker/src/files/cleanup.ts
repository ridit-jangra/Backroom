import { ORPHAN_TTL_MS } from '@backroom/protocol';
import type { Env } from '../env';
import { getBlobStore } from '../lib/blobs';
import { ApiError } from '../lib/errors';
import { FILE_KEY_RE } from './store';

export const ORPHAN_BATCH = 100;
export const ORPHAN_MAX_BATCHES = 10;
/**
 * Blob deletes per run. Workers KV allows 1,000 deletes a day (shared with emoji deletes and upload cleanups) and
 * has no batch delete, so each key is one delete. Whatever is left waits for the next daily run.
 */
export const ORPHAN_MAX_DELETES = 200;

type Row = { id: string; key: string; thumbKey: string | null };

/**
 * Removes files nobody linked to a message within ORPHAN_TTL_MS (never attached, or their message was deleted).
 * Per batch: pick the oldest candidates whose blob keys (stored r2_key/thumb_key, guarded by FILE_KEY_RE so
 * `emoji/` keys are never touched) fit in the remaining delete budget, delete those blobs, then the rows.
 * Attach refuses files this old (P4-R8), so a valid attach cannot race the removal.
 *
 * A blob delete failure is logged and the rows still go (as before). At the KV daily limit (`storage_busy`) the
 * run stops and keeps that batch's rows, so the next run retries their keys instead of leaking them.
 */
export async function cleanupOrphans(env: Env, now: number): Promise<{ deleted: number; keysRejected: number }> {
  const store = getBlobStore(env);
  let deleted = 0;
  let keysRejected = 0;
  let budget = ORPHAN_MAX_DELETES;
  for (let i = 0; i < ORPHAN_MAX_BATCHES && budget > 0; i++) {
    const { results } = await env.DB.prepare(
      `SELECT f.id AS id, f.r2_key AS key, f.thumb_key AS thumbKey FROM files f
       WHERE f.created_at < ?1 AND NOT EXISTS (SELECT 1 FROM message_files mf WHERE mf.file_id = f.id)
       ORDER BY f.created_at LIMIT ?2`,
    )
      .bind(now - ORPHAN_TTL_MS, ORPHAN_BATCH)
      .all<Row>();

    const ids: string[] = [];
    const keys: string[] = [];
    let rejected = 0;
    for (const r of results) {
      const candidates = r.thumbKey ? [r.key, r.thumbKey] : [r.key];
      const valid = candidates.filter((k) => FILE_KEY_RE.test(k));
      if (keys.length + valid.length > budget) break;
      ids.push(r.id);
      keys.push(...valid);
      rejected += candidates.length - valid.length;
    }
    if (ids.length === 0) break;
    if (rejected > 0) console.warn(JSON.stringify({ level: 'warn', code: 'orphan_key_rejected' }));

    if (keys.length > 0) {
      try {
        await store.delete(keys);
      } catch (e) {
        if (e instanceof ApiError && e.code === 'storage_busy') {
          console.warn(JSON.stringify({ level: 'warn', code: 'orphan_delete_limited' }));
          break;
        }
        console.error(JSON.stringify({ level: 'error', code: 'orphan_r2_delete_failed' }));
      }
    }
    budget -= keys.length;

    // RETURNING, not meta.changes: the latter also counts the files_fts trigger rows.
    const del = await env.DB.prepare(
      `DELETE FROM files WHERE id IN (SELECT value FROM json_each(?1))
         AND created_at < ?2 AND NOT EXISTS (SELECT 1 FROM message_files mf WHERE mf.file_id = files.id)
       RETURNING id`,
    )
      .bind(JSON.stringify(ids), now - ORPHAN_TTL_MS)
      .all();
    deleted += del.results.length;
    keysRejected += rejected;

    if (ids.length < results.length || results.length < ORPHAN_BATCH) break;
  }
  console.info(JSON.stringify({ level: 'info', code: 'orphans_cleaned', deleted }));
  return { deleted, keysRejected };
}
