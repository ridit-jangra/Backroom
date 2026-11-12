import { FILES_QUOTA_BYTES, type FileInfo } from '@backroom/protocol';
import type { Env } from '../env';
import { ApiError } from '../lib/errors';
import { newId } from '../lib/ids';
import { SNIFF_BYTES, sniffFile } from './sniff';

/** R2 key of an original upload. Both parts are server values (DB workspace id, server ULID), never user input. */
export function fileKey(workspaceId: string, fileId: string): string {
  return `ws/${workspaceId}/${fileId}`;
}

export function thumbKeyOf(workspaceId: string, fileId: string): string {
  return `${fileKey(workspaceId, fileId)}-thumb`;
}

/** Every key a file delete may touch. Never matches `ws/<id>/emoji/<id>`. */
export const FILE_KEY_RE = /^ws\/[0-9A-Z]{26}\/[0-9A-Z]{26}(-thumb)?$/;

/** SELECT list for `files` rows that become `FileInfo` (unprefixed; pair with `rowToFileInfo`). */
export const FILE_INFO_COLUMNS = 'id, name, mime, size, width, height, thumb_key IS NOT NULL AS hasThumb';

export type FileInfoRow = {
  id: string;
  name: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  hasThumb: number | boolean;
};

export function rowToFileInfo(row: FileInfoRow): FileInfo {
  return {
    id: row.id,
    name: row.name,
    mime: row.mime,
    size: row.size,
    width: row.width,
    height: row.height,
    hasThumb: Boolean(row.hasThumb),
  };
}

/**
 * Streams exactly `length` bytes into R2 without buffering: the native FixedLengthStream gives R2 a known
 * length and errors on a short or long body. On any failure the key is deleted (best effort) and the error rethrown.
 */
export async function putExact(bucket: R2Bucket, key: string, body: ReadableStream, length: number): Promise<void> {
  try {
    await bucket.put(key, body.pipeThrough(new FixedLengthStream(length)));
  } catch (e) {
    await bucket.delete(key).catch(() => {});
    throw e;
  }
}

export const quotaExceeded = () => new ApiError(413, 'quota_exceeded', 'This workspace has used its 2 GB of file storage.');

async function cleanup(bucket: R2Bucket, key: string): Promise<void> {
  await bucket.delete(key).catch(() => {
    console.error(JSON.stringify({ level: 'error', code: 'upload_cleanup_failed' }));
  });
}

/**
 * Streams the body to R2, sniffs the stored type from the first bytes (range get), then inserts the row only if
 * the workspace's `SUM(files.size)` stays within the quota. Any failure after the put removes the object again.
 */
export async function storeUpload(
  env: Env,
  input: { workspaceId: string; userId: string; name: string; declaredType: string | null; length: number; body: ReadableStream; now: number },
): Promise<FileInfo> {
  const id = newId(input.now);
  const key = fileKey(input.workspaceId, id);
  const bucket = env.BUCKET;

  try {
    await putExact(bucket, key, input.body, input.length);
  } catch {
    throw new ApiError(400, 'invalid_request', 'The upload did not complete.');
  }

  let changes: number;
  let sniffed: ReturnType<typeof sniffFile>;
  try {
    let head: Uint8Array = new Uint8Array(0);
    if (input.length > 0) {
      const obj = await bucket.get(key, { range: { offset: 0, length: Math.min(input.length, SNIFF_BYTES) } });
      if (obj) head = await obj.bytes();
    }
    sniffed = sniffFile(head, input.declaredType);
    const r = await env.DB.prepare(
      `INSERT INTO files (id, workspace_id, uploader_id, r2_key, thumb_key, name, mime, size, width, height, created_at)
       SELECT ?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?8, ?9, ?10
       WHERE (SELECT COALESCE(SUM(size), 0) FROM files WHERE workspace_id = ?2) + ?7 <= ?11`,
    )
      .bind(id, input.workspaceId, input.userId, key, input.name, sniffed.mime, input.length, sniffed.width, sniffed.height, input.now, FILES_QUOTA_BYTES)
      .run();
    changes = r.meta.changes;
  } catch (e) {
    await cleanup(bucket, key);
    throw e;
  }
  if (changes === 0) {
    await cleanup(bucket, key);
    throw quotaExceeded();
  }
  return { id, name: input.name, mime: sniffed.mime, size: input.length, width: sniffed.width, height: sniffed.height, hasThumb: false };
}
