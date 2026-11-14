import { ApiError } from './errors';

/**
 * Bytes of blob storage a workspace uses: originals and thumbnails (`files.size + files.thumb_size`) plus custom
 * emoji images (`custom_emoji.size`). Every blob lives in the one KV namespace, so FILES_QUOTA_BYTES bounds them all.
 * `ws` is the SQL parameter holding the workspace id (e.g. `?2`). Built at call time, never at module scope (P4-R7).
 */
export function blobBytesUsedSql(ws: string): string {
  return `((SELECT COALESCE(SUM(size + thumb_size), 0) FROM files WHERE workspace_id = ${ws}) + (SELECT COALESCE(SUM(size), 0) FROM custom_emoji WHERE workspace_id = ${ws}))`;
}

export const quotaExceeded = () =>
  new ApiError(413, 'quota_exceeded', 'This workspace has used its 900 MB of storage (files, thumbnails and custom emoji).');

/** Bytes the workspace uses now (for the early, non-atomic checks; conditional writes re-check atomically). */
export async function blobBytesUsed(db: D1Database, workspaceId: string): Promise<number> {
  const r = await db.prepare(`SELECT ${blobBytesUsedSql('?1')} AS used`).bind(workspaceId).first<{ used: number }>();
  return r?.used ?? 0;
}
