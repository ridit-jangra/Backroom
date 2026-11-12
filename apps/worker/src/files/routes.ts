import { Hono } from 'hono';
import { FILE_MAX_BYTES, FILES_QUOTA_BYTES, THUMB_MAX_BYTES, THUMB_MAX_SIDE, isRasterImage, sanitizeFileName } from '@backroom/protocol';
import type { AppEnv } from '../app';
import { readCappedBody } from '../lib/body';
import { ApiError } from '../lib/errors';
import { requireSession } from '../middleware/session';
import { requireMember } from '../workspace/access';
import { sniffFile } from './sniff';
import { FILE_INFO_COLUMNS, type FileInfoRow, quotaExceeded, rowToFileInfo, storeUpload, thumbKeyOf } from './store';

export const fileRoutes = new Hono<AppEnv>();

const ID_RE = /^[0-9A-Z]{26}$/;
const LENGTH_RE = /^\d{1,9}$/;
const notFound = () => new ApiError(404, 'not_found', 'File not found.');
const invalidThumbnail = () => new ApiError(400, 'invalid_thumbnail', 'Thumbnails must be WebP images of at most 720×720 pixels.');
const alreadyAttached = () => new ApiError(409, 'already_attached', 'This file is already attached to a message.');
const alreadyHasThumbnail = () => new ApiError(409, 'already_has_thumbnail', 'This file already has a thumbnail.');

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

  const file = await storeUpload(c.env, {
    workspaceId,
    userId,
    name,
    declaredType: c.req.header('Content-Type') ?? null,
    length,
    body,
    now: c.var.deps.now(),
  });
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

  const key = thumbKeyOf(row.workspaceId, id);
  await c.env.BUCKET.put(key, bytes, { httpMetadata: { contentType: 'image/webp' } });
  const r = await db
    .prepare(
      `UPDATE files SET thumb_key = ?1
       WHERE id = ?2 AND thumb_key IS NULL AND NOT EXISTS (SELECT 1 FROM message_files WHERE file_id = ?2)`,
    )
    .bind(key, id)
    .run();

  if (r.meta.changes === 0) {
    // Lost a race (attach, another thumbnail, or the row is gone). Only remove the object when no row points at it.
    const now = await db
      .prepare('SELECT thumb_key AS thumbKey FROM files WHERE id = ?')
      .bind(id)
      .first<{ thumbKey: string | null }>();
    if (!now || now.thumbKey === null) {
      await c.env.BUCKET.delete(key).catch(() => {
        console.error(JSON.stringify({ level: 'error', code: 'upload_cleanup_failed' }));
      });
    }
    if (!now) throw notFound();
    if (now.thumbKey !== null) throw alreadyHasThumbnail();
    throw alreadyAttached();
  }

  const file = await db.prepare(`SELECT ${FILE_INFO_COLUMNS} FROM files WHERE id = ?`).bind(id).first<FileInfoRow>();
  if (!file) throw notFound();
  return c.json({ file: rowToFileInfo(file) });
});
