import { FILE_MAX_BYTES, FILES_QUOTA_BYTES } from '@backroom/protocol';
import type { Env } from '../env';
import { ApiError } from './errors';

/** A host's optional byte-count override (the Node server sets these from its config; Workers leaves them unset). */
function bytesFromEnv(value: unknown, fallback: number): number {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

/** The per-workspace blob quota: `env.FILES_QUOTA_BYTES` when set to a positive integer, else FILES_QUOTA_BYTES. */
export function filesQuotaBytes(env: Pick<Env, 'FILES_QUOTA_BYTES'>): number {
  return bytesFromEnv(env.FILES_QUOTA_BYTES, FILES_QUOTA_BYTES);
}

/** The largest upload: `env.FILE_MAX_BYTES` when set to a positive integer, else FILE_MAX_BYTES. */
export function fileMaxBytes(env: Pick<Env, 'FILE_MAX_BYTES'>): number {
  return bytesFromEnv(env.FILE_MAX_BYTES, FILE_MAX_BYTES);
}

/** "25 MB" for 25 MiB (the wording the app has always used for binary megabytes). */
export function megabytes(bytes: number): string {
  return `${Math.round((bytes / 1_048_576) * 10) / 10} MB`;
}

/**
 * Bytes of blob storage a workspace uses: originals and thumbnails (`files.size + files.thumb_size`) plus custom
 * emoji images (`custom_emoji.size`). Every blob lives in the one KV namespace, so FILES_QUOTA_BYTES bounds them all.
 * `ws` is the SQL parameter holding the workspace id (e.g. `?2`). Built at call time, never at module scope (P4-R7).
 */
export function blobBytesUsedSql(ws: string): string {
  return `((SELECT COALESCE(SUM(size + thumb_size), 0) FROM files WHERE workspace_id = ${ws}) + (SELECT COALESCE(SUM(size), 0) FROM custom_emoji WHERE workspace_id = ${ws}))`;
}

export const quotaExceeded = (quotaBytes: number) =>
  new ApiError(413, 'quota_exceeded', `This workspace has used its ${megabytes(quotaBytes)} of storage (files, thumbnails and custom emoji).`);

/** Bytes the workspace uses now (for the early, non-atomic checks; conditional writes re-check atomically). */
export async function blobBytesUsed(db: D1Database, workspaceId: string): Promise<number> {
  const r = await db.prepare(`SELECT ${blobBytesUsedSql('?1')} AS used`).bind(workspaceId).first<{ used: number }>();
  return r?.used ?? 0;
}
