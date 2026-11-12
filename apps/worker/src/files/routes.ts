import { type Context, Hono } from 'hono';
import { type FileInfo, FILE_MAX_BYTES, FILES_QUOTA_BYTES, THUMB_MAX_BYTES, THUMB_MAX_SIDE, isRasterImage, sanitizeFileName } from '@backroom/protocol';
import type { AppEnv } from '../app';
import { readCappedBody } from '../lib/body';
import { newId } from '../lib/ids';
import { ApiError } from '../lib/errors';
import { requireSession } from '../middleware/session';
import { MEDIA_SECURITY_HEADERS } from '../lib/media';
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
 * Registers `p` with `waitUntil` so the work after the body has been received (R2 put commit, D1 insert, cleanup)
 * runs to completion even if the client disconnects: otherwise an abort right after the last byte could leave a
 * committed R2 object with no D1 row, which neither the quota nor the orphan cron would ever see.
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

// The body is never read here: storeUpload streams it straight into R2.
fileRoutes.post('/w/:slug/files', requireSession, async (c) => {
  const db = c.env.DB;
  const userId = c.var.session!.userId;
  const { workspaceId } = await requireMember(db, c.req.param('slug'), userId);

  const lengthHeader = c.req.header('Content-Length');
  if (lengthHeader === undefined || !LENGTH_RE.test(lengthHeader)) {
    throw new ApiError(411, 'length_required', 'Uploads need a Content-Length.');
  }
  const length = Number(lengthHeader);
  if (length > FILE_MAX_BYTES) throw new ApiError(413, 'too_large', 'Files must be 25 MB or smaller.');

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
  const used = await db
    .prepare('SELECT COALESCE(SUM(size), 0) AS used FROM files WHERE workspace_id = ?')
    .bind(workspaceId)
    .first<{ used: number }>();
  if ((used?.used ?? 0) + length > FILES_QUOTA_BYTES) throw quotaExceeded();

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

  const file = await surviveDisconnect(c, storeThumbnail(c.env, { workspaceId: row.workspaceId, id, bytes, now: c.var.deps.now() }));
  return c.json({ file });
});

/**
 * Writes the thumbnail under a fresh unique key, then links it only if the file still has no thumbnail and is
 * not attached. A loser of any race deletes only its own new object, so the live thumbnail is never touched.
 */
async function storeThumbnail(
  env: AppEnv['Bindings'],
  input: { workspaceId: string; id: string; bytes: Uint8Array; now: number },
): Promise<FileInfo> {
  const db = env.DB;
  const key = thumbKeyOf(input.workspaceId, input.id, newId(input.now));
  await env.BUCKET.put(key, input.bytes, { httpMetadata: { contentType: 'image/webp' } });
  let changes: number;
  try {
    const r = await db
      .prepare(
        `UPDATE files SET thumb_key = ?1
         WHERE id = ?2 AND thumb_key IS NULL AND NOT EXISTS (SELECT 1 FROM message_files WHERE file_id = ?2)`,
      )
      .bind(key, input.id)
      .run();
    changes = r.meta.changes;
  } catch (e) {
    await cleanupThumb(env.BUCKET, key);
    throw e;
  }
  if (changes === 0) {
    await cleanupThumb(env.BUCKET, key);
    const now = await db.prepare('SELECT thumb_key AS thumbKey FROM files WHERE id = ?').bind(input.id).first<{ thumbKey: string | null }>();
    if (!now) throw notFound();
    if (now.thumbKey !== null) throw alreadyHasThumbnail();
    throw alreadyAttached();
  }
  const file = await db.prepare(`SELECT ${FILE_INFO_COLUMNS} FROM files WHERE id = ?`).bind(input.id).first<FileInfoRow>();
  if (!file) throw notFound();
  return rowToFileInfo(file);
}

async function cleanupThumb(bucket: R2Bucket, key: string): Promise<void> {
  await bucket.delete(key).catch(() => {
    console.error(JSON.stringify({ level: 'error', code: 'upload_cleanup_failed' }));
  });
}

const hasBody = (o: R2Object | R2ObjectBody): o is R2ObjectBody => 'body' in o;

/** The id check plus §8 visibility; unknown and not visible give the identical 404. */
async function requireFileAccess(c: Context<AppEnv>): Promise<FileAccess> {
  const id = c.req.param('id') ?? '';
  if (!ID_RE.test(id)) throw notFound();
  const row = await loadFileAccess(c.env.DB, id, c.var.session!.userId);
  if (!row) throw notFound();
  return row;
}

/**
 * R2 get honouring If-None-Match: a matching etag yields an object without a body (⇒ 304).
 * A malformed validator makes the conditional get throw; it must not 500 (P3-R16), so serve unconditionally.
 */
async function conditionalGet(
  bucket: R2Bucket,
  key: string,
  ifNoneMatch: string | undefined,
  range?: { offset: number; length: number },
): Promise<R2Object | R2ObjectBody | null> {
  if (!ifNoneMatch) return bucket.get(key, { range });
  try {
    return await bucket.get(key, { onlyIf: new Headers({ 'If-None-Match': ifNoneMatch }), range });
  } catch {
    return bucket.get(key, { range });
  }
}

fileRoutes.get('/files/:id', requireSession, async (c) => {
  const row = await requireFileAccess(c);

  // If-Range always serves the full file: we never compare validators, which is the safe reading of RFC 9110.
  const range = c.req.header('If-Range') === undefined ? parseRange(c.req.header('Range') ?? null, row.size) : null;
  if (range === 'unsatisfiable') {
    // P4-R5: decided before the R2 get, so no etag; the body is the standard {error} shape.
    const headers = new Headers(MEDIA_SECURITY_HEADERS);
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Content-Range', `bytes */${row.size}`);
    headers.set('Content-Type', 'application/json');
    return new Response(JSON.stringify({ error: { code: 'range_not_satisfiable', message: 'That range is outside the file.' } }), {
      status: 416,
      headers,
    });
  }

  const obj = await conditionalGet(c.env.BUCKET, row.r2Key, c.req.header('If-None-Match'), range ?? undefined);
  if (!obj) throw notFound();
  const headers = fileHeaders(row, obj.httpEtag);
  if (!hasBody(obj)) return new Response(null, { status: 304, headers });
  if (range) {
    headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${row.size}`);
    headers.set('Content-Length', String(range.length));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set('Content-Length', String(obj.size));
  return new Response(obj.body, { status: 200, headers });
});

// Thumbnails are always served whole (they are ≤ 512 KB): Range is ignored.
fileRoutes.get('/files/:id/thumb', requireSession, async (c) => {
  const row = await requireFileAccess(c);
  // P4-R22: always the stored key (`…-thumb-<ULID>`), never a derived one.
  if (row.thumbKey === null) throw notFound();
  const obj = await conditionalGet(c.env.BUCKET, row.thumbKey, c.req.header('If-None-Match'));
  if (!obj) throw notFound();
  const headers = fileHeaders({ mime: 'image/webp', name: 'thumbnail.webp' }, obj.httpEtag);
  if (!hasBody(obj)) return new Response(null, { status: 304, headers });
  headers.set('Content-Length', String(obj.size));
  return new Response(obj.body, { status: 200, headers });
});
