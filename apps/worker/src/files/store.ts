import { FILES_QUOTA_BYTES, type FileInfo } from '@backroom/protocol';
import type { Env } from '../env';
import { type BlobStore, deleteOrLog, getBlobStore } from '../lib/blobs';
import { ApiError } from '../lib/errors';
import { newId } from '../lib/ids';
import { blobBytesUsedSql, quotaExceeded } from '../lib/quota';
import { SNIFF_BYTES, sniffFile } from './sniff';

/** Blob key of an original upload. Both parts are server values (DB workspace id, server ULID), never user input. */
export function fileKey(workspaceId: string, fileId: string): string {
  return `ws/${workspaceId}/${fileId}`;
}

/**
 * Blob key of a thumbnail: `ws/<workspaceId>/<fileId>-thumb-<thumbId>`, where `thumbId` is a fresh server ULID per
 * thumbnail upload. A unique key per upload means a losing concurrent upload can delete its own object without
 * ever touching the live thumbnail; readers always use the stored `files.thumb_key`.
 */
export function thumbKeyOf(workspaceId: string, fileId: string, thumbId: string): string {
  return `${fileKey(workspaceId, fileId)}-thumb-${thumbId}`;
}

/**
 * Every key a file delete may touch: an original or a thumbnail. Only uppercase ULIDs and exactly two slashes,
 * so it can never match a custom emoji key `ws/<id>/emoji/<id>`.
 */
export const FILE_KEY_RE = /^ws\/[0-9A-Z]{26}\/[0-9A-Z]{26}(-thumb-[0-9A-Z]{26})?$/;

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

/** The upload body itself was bad: shorter or longer than its length, or the client's stream failed. */
export class UploadStreamError extends Error {
  constructor(cause: unknown) {
    super('upload stream failed', { cause });
    this.name = 'UploadStreamError';
  }
}

// workerd's FixedLengthStream length-mismatch errors ("did not see all expected bytes", "too many bytes").
const isLengthMismatch = (e: unknown): boolean => e instanceof TypeError && /FixedLengthStream/.test(e.message);

/**
 * Streams exactly `length` bytes into blob storage without buffering: the native FixedLengthStream gives KV/R2 a
 * known length and errors on a short or long body. On failure the key is deleted (best effort), except when the
 * store itself rejected an intact body and says such a put leaves nothing (KV, whose deletes are capped), and except
 * at the KV daily limit. A broken body is always cleaned up: local KV keeps the partial value in that case. A failure caused by the body (length mismatch,
 * or the source stream erroring, e.g. a client disconnect) is thrown as `UploadStreamError`; anything else (a
 * storage failure, or `503 storage_busy`) is rethrown as is.
 */
export async function putExact(store: BlobStore, key: string, body: ReadableStream, length: number): Promise<void> {
  const fixed = new FixedLengthStream(length);
  const abort = new AbortController();
  let sourceFailed = false;
  // An explicit, observed pipe (native stream to native stream) so a source failure is known when put rejects.
  const piped = body.pipeTo(fixed.writable, { signal: abort.signal }).catch(() => {
    sourceFailed = true;
  });
  try {
    await store.put(key, fixed.readable, { size: length });
  } catch (e) {
    // Classify before anything else can settle: a later pipe rejection could be our own abort below.
    const streamFault = sourceFailed || isLengthMismatch(e);
    abort.abort();
    const mayHaveWritten = streamFault || !store.failedPutLeavesNothing;
    if (mayHaveWritten && !(e instanceof ApiError)) await store.delete(key).catch(() => {});
    throw streamFault ? new UploadStreamError(e) : e;
  }
  await piped;
}

export { quotaExceeded };

const cleanup = (store: BlobStore, key: string): Promise<void> => deleteOrLog(store, key, 'file', 'upload_cleanup_failed');

/**
 * Streams the body to blob storage, sniffs the stored type from the first bytes (peek), then inserts the row only if
 * the workspace's blob bytes (files, thumbnails, custom emoji: `blobBytesUsedSql`) stay within the quota. Any failure after the put removes the object again.
 */
export async function storeUpload(
  env: Env,
  input: { workspaceId: string; userId: string; name: string; declaredType: string | null; length: number; body: ReadableStream; now: number },
): Promise<FileInfo> {
  const id = newId(input.now);
  const key = fileKey(input.workspaceId, id);
  const store = getBlobStore(env);

  try {
    await putExact(store, key, input.body, input.length);
  } catch (e) {
    if (e instanceof UploadStreamError) throw new ApiError(400, 'invalid_request', 'The upload did not complete.');
    if (e instanceof ApiError) throw e; // 503 storage_busy
    console.error(JSON.stringify({ level: 'error', code: 'r2_put_failed' }));
    throw new ApiError(500, 'upload_failed', 'The file could not be stored. Try again.');
  }

  let changes: number;
  let sniffed: ReturnType<typeof sniffFile>;
  try {
    let head: Uint8Array = new Uint8Array(0);
    if (input.length > 0) head = (await store.peek(key, Math.min(input.length, SNIFF_BYTES))) ?? head;
    sniffed = sniffFile(head, input.declaredType);
    const r = await env.DB.prepare(
      `INSERT INTO files (id, workspace_id, uploader_id, r2_key, thumb_key, name, mime, size, width, height, created_at)
       SELECT ?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?8, ?9, ?10
       WHERE ${blobBytesUsedSql('?2')} + ?7 <= ?11`,
    )
      .bind(id, input.workspaceId, input.userId, key, input.name, sniffed.mime, input.length, sniffed.width, sniffed.height, input.now, FILES_QUOTA_BYTES)
      .run();
    changes = r.meta.changes;
  } catch (e) {
    await cleanup(store, key);
    throw e;
  }
  if (changes === 0) {
    await cleanup(store, key);
    throw quotaExceeded();
  }
  return { id, name: input.name, mime: sniffed.mime, size: input.length, width: sniffed.width, height: sniffed.height, hasThumb: false };
}
