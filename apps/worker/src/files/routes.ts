import { type Context, Hono } from 'hono';
import { type FileInfo, THUMB_MAX_BYTES, THUMB_MAX_SIDE, isRasterImage, sanitizeFileName } from '@backroom/protocol';
import type { AppEnv } from '../app';
import { type BlobStore, deleteOrLog, getBlobStore } from '../lib/blobs';
import { readCappedBody } from '../lib/body';
import { newId } from '../lib/ids';
import { ApiError } from '../lib/errors';
import { blobBytesUsed, blobBytesUsedSql, fileMaxBytes, filesQuotaBytes, megabytes } from '../lib/quota';
import { requireSession } from '../middleware/session';
import { MEDIA_SECURITY_HEADERS, blobPendingResponse } from '../lib/media';
import { requireMember } from '../workspace/access';
import { type FileAccess, loadFileAccess } from './access';
import { fileHeaders, parseRange } from './http';
import { sniffFile } from './sniff';
import { FILE_INFO_COLUMNS, type FileInfoRow, quotaExceeded, rowToFileInfo, storeUpload, thumbKeyOf } from './store';

export const fileRoutes = new Hono<AppEnv>();

const ID_RE = /^[0-9A-Z]{26}$/;
const LENGTH_RE = /^\d{1,9}$/;
const notFound = () => new ApiError(404, 'not_found', 'File not found.');
const invalidThumbnail = () => new ApiError(400, 'invalid_thumbnail', 'Thumbnails must be WebP images of at most 720×720 pixels.');
const alreadyAttached = () => new ApiError(409, 'already_attached', 'This file is already attached to a message.');
const alreadyHasThumbnail = () => new ApiError(409, 'already_has_thumbnail', 'This file already has a thumbnail.');

/**
 * Registers `p` with `waitUntil` so the work after the body has been received (blob put commit, D1 insert, cleanup)
 * runs to completion even if the client disconnects: otherwise an abort right after the last byte could leave a
 * committed blob with no D1 row, which neither the quota nor the orphan cron would ever see.
 * Without an execution context (some unit tests), the caller's own await is all there is.
 */
export function surviveDisconnect<T>(c: Context<AppEnv>, p: Promise<T>): Promise<T> {
  let ctx: { waitUntil(p: Promise<unknown>): void } | undefined;
  try {
    ctx = c.executionCtx;
  } catch {
    ctx = undefined;
  }
  ctx?.waitUntil(p.catch(() => {}));
  return p;
}

// The body is never read here: storeUpload streams it straight into blob storage.
fileRoutes.post('/w/:slug/files', requireSession, async (c) => {
  const db = c.env.DB;
  const userId = c.var.session!.userId;
  const { workspaceId } = await requireMember(db, c.req.param('slug'), userId);

  const lengthHeader = c.req.header('Content-Length');
  if (lengthHeader === undefined || !LENGTH_RE.test(lengthHeader)) {
    throw new ApiError(411, 'length_required', 'Uploads need a Content-Length.');
  }
  const length = Number(lengthHeader);
  const maxBytes = fileMaxBytes(c.env);
  if (length > maxBytes) throw new ApiError(413, 'too_large', `Files must be ${megabytes(maxBytes)} or smaller.`);

  const raw = c.req.raw.body;
  if (length > 0 && raw === null) throw new ApiError(400, 'invalid_request', 'The upload has no body.');
  const body =
    raw ??
    new ReadableStream({
      start(ctrl) {
        ctrl.close();
      },
    });

  const name = sanitizeFileName(c.req.query('name') ?? '');

  // Fail fast before streaming; the conditional insert re-checks atomically.
  const quota = filesQuotaBytes(c.env);
  if ((await blobBytesUsed(db, workspaceId)) + length > quota) throw quotaExceeded(quota);

  const file = await surviveDisconnect(
    c,
    storeUpload(c.env, {
      workspaceId,
      userId,
      name,
      declaredType: c.req.header('Content-Type') ?? null,
      length,
      body,
      now: c.var.deps.now(),
    }),
  );
  return c.json({ file }, 201);
});

type ThumbRow = { workspaceId: string; mime: string; thumbKey: string | null; attached: number };

async function loadOwnFile(db: D1Database, id: string, userId: string): Promise<ThumbRow | null> {
  return db
    .prepare(
      `SELECT f.workspace_id AS workspaceId, f.mime AS mime, f.thumb_key AS thumbKey,
              EXISTS (SELECT 1 FROM message_files WHERE file_id = f.id) AS attached
       FROM files f
       JOIN workspace_members wm ON wm.workspace_id = f.workspace_id AND wm.user_id = f.uploader_id AND wm.deactivated_at IS NULL
       WHERE f.id = ? AND f.uploader_id = ?`,
    )
    .bind(id, userId)
    .first<ThumbRow>();
}

fileRoutes.post('/files/:id/thumb', requireSession, async (c) => {
  const db = c.env.DB;
  const userId = c.var.session!.userId;
  const id = c.req.param('id');
  if (!ID_RE.test(id)) throw notFound();

  const row = await loadOwnFile(db, id, userId);
  if (!row) throw notFound();
  if (row.attached) throw alreadyAttached();
  // P4-R20: one thumbnail per file, so a late second post can never replace an attached file's live thumbnail.
  if (row.thumbKey !== null) throw alreadyHasThumbnail();
  if (!isRasterImage(row.mime)) throw invalidThumbnail();

  const bytes = await readCappedBody(c.req.raw, THUMB_MAX_BYTES, () => new ApiError(413, 'too_large', 'Thumbnails must be 512 KB or smaller.'));
  const sniffed = sniffFile(bytes, null);
  if (
    sniffed.mime !== 'image/webp' ||
    sniffed.width === null ||
    sniffed.height === null ||
    sniffed.width < 1 ||
    sniffed.height < 1 ||
    sniffed.width > THUMB_MAX_SIDE ||
    sniffed.height > THUMB_MAX_SIDE
  ) {
    throw invalidThumbnail();
  }
  // Thumbnails count toward the quota too. Fail fast before the KV write; the UPDATE re-checks atomically.
  const quota = filesQuotaBytes(c.env);
  if ((await blobBytesUsed(db, row.workspaceId)) + bytes.byteLength > quota) throw quotaExceeded(quota);

  const file = await surviveDisconnect(c, storeThumbnail(c.env, { workspaceId: row.workspaceId, id, bytes, now: c.var.deps.now() }));
  return c.json({ file });
});

/**
 * Writes the thumbnail under a fresh unique key, then links it (recording `thumb_size`) only if the file still has
 * no thumbnail, is not attached, and the workspace's blob bytes stay within the quota. A loser of any race deletes
 * only its own new object, so the live thumbnail is never touched.
 */
async function storeThumbnail(
  env: AppEnv['Bindings'],
  input: { workspaceId: string; id: string; bytes: Uint8Array; now: number },
): Promise<FileInfo> {
  const db = env.DB;
  const key = thumbKeyOf(input.workspaceId, input.id, newId(input.now));
  const store = getBlobStore(env);
  await store.put(key, input.bytes, { contentType: 'image/webp', size: input.bytes.byteLength });
  let changes: number;
  try {
    const r = await db
      .prepare(
        `UPDATE files SET thumb_key = ?1, thumb_size = ?3
         WHERE id = ?2 AND thumb_key IS NULL AND NOT EXISTS (SELECT 1 FROM message_files WHERE file_id = ?2)
           AND ${blobBytesUsedSql('?4')} + ?3 <= ?5`,
      )
      .bind(key, input.id, input.bytes.byteLength, input.workspaceId, filesQuotaBytes(env))
      .run();
    changes = r.meta.changes;
  } catch (e) {
    await cleanupThumb(store, key);
    throw e;
  }
  if (changes === 0) {
    await cleanupThumb(store, key);
    const now = await db
      .prepare('SELECT thumb_key AS thumbKey, EXISTS (SELECT 1 FROM message_files WHERE file_id = ?1) AS attached FROM files WHERE id = ?1')
      .bind(input.id)
      .first<{ thumbKey: string | null; attached: number }>();
    if (!now) throw notFound();
    if (now.thumbKey !== null) throw alreadyHasThumbnail();
    if (now.attached) throw alreadyAttached();
    throw quotaExceeded(filesQuotaBytes(env));
  }
  const file = await db.prepare(`SELECT ${FILE_INFO_COLUMNS} FROM files WHERE id = ?`).bind(input.id).first<FileInfoRow>();
  if (!file) throw notFound();
  return rowToFileInfo(file);
}

const cleanupThumb = (store: BlobStore, key: string): Promise<void> => deleteOrLog(store, key, 'thumb', 'upload_cleanup_failed');

/** The id check plus §8 visibility; unknown and not visible give the identical 404. */
async function requireFileAccess(c: Context<AppEnv>): Promise<FileAccess> {
  const id = c.req.param('id') ?? '';
  if (!ID_RE.test(id)) throw notFound();
  const row = await loadFileAccess(c.env.DB, id, c.var.session!.userId);
  if (!row) throw notFound();
  return row;
}

/**
 * Blob get honouring If-None-Match: a matching etag yields `notModified` without a body (⇒ 304). A malformed
 * validator is ignored by the store (P3-R16: never a 500). An empty header counts as absent.
 */
function conditionalGet(c: Context<AppEnv>, key: string, range?: { offset: number; length: number }) {
  return getBlobStore(c.env).get(key, { range, ifNoneMatch: c.req.header('If-None-Match') || undefined });
}

fileRoutes.get('/files/:id', requireSession, async (c) => {
  const row = await requireFileAccess(c);

  // If-Range always serves the full file: we never compare validators, which is the safe reading of RFC 9110.
  const range = c.req.header('If-Range') === undefined ? parseRange(c.req.header('Range') ?? null, row.size) : null;
  if (range === 'unsatisfiable') {
    // P4-R5: decided before the blob get, so no etag; the body is the standard {error} shape.
    const headers = new Headers(MEDIA_SECURITY_HEADERS);
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Content-Range', `bytes */${row.size}`);
    headers.set('Content-Type', 'application/json');
    return new Response(JSON.stringify({ error: { code: 'range_not_satisfiable', message: 'That range is outside the file.' } }), {
      status: 416,
      headers,
    });
  }

  const obj = await conditionalGet(c, row.r2Key, range ?? undefined);
  if (!obj) return blobPendingResponse();
  const headers = fileHeaders(row, obj.etag);
  if (obj.notModified) return new Response(null, { status: 304, headers });
  if (range) {
    headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${row.size}`);
    headers.set('Content-Length', String(range.length));
    // A native fixed-length body, so the wire Content-Length is exact (the KV slice is a JS stream); a short source
    // still errors the response rather than ending it early.
    return new Response(obj.body!.pipeThrough(new FixedLengthStream(range.length)), { status: 206, headers });
  }
  headers.set('Content-Length', String(obj.size));
  return new Response(obj.body, { status: 200, headers });
});

// Thumbnails are always served whole (they are ≤ 512 KB): Range is ignored.
fileRoutes.get('/files/:id/thumb', requireSession, async (c) => {
  const row = await requireFileAccess(c);
  // P4-R22: always the stored key (`…-thumb-<ULID>`), never a derived one.
  if (row.thumbKey === null) throw notFound();
  const obj = await conditionalGet(c, row.thumbKey);
  if (!obj) return blobPendingResponse();
  const headers = fileHeaders({ mime: 'image/webp', name: 'thumbnail.webp' }, obj.etag);
  if (obj.notModified) return new Response(null, { status: 304, headers });
  headers.set('Content-Length', String(obj.size));
  return new Response(obj.body, { status: 200, headers });
});
