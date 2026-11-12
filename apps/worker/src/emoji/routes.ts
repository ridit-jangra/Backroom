import { Hono } from 'hono';
import {
  CUSTOM_EMOJI_LIMIT,
  CUSTOM_EMOJI_MAX_BYTES,
  CUSTOM_EMOJI_MAX_SIDE,
  CUSTOM_EMOJI_MIN_SIDE,
  CUSTOM_EMOJI_UPLOAD_MAX_BYTES,
  CustomEmojiAliasBody,
  EmojiName,
  type CustomEmoji,
  canAddCustomEmoji,
} from '@backroom/protocol';
import { lookupEmoji } from '@backroom/emoji';
import type { AppEnv } from '../app';
import { hubFor } from '../hub/client';
import { ApiError } from '../lib/errors';
import { requireSession } from '../middleware/session';
import { requireMember } from '../workspace/access';
import { readJson } from '../lib/http';
import { createCustomAlias, createCustomEmoji, deleteCustomEmoji, limitReached, listCustomEmoji, readSettings } from './custom';
import { sniffImage } from './image';

export const emojiRoutes = new Hono<AppEnv>();

const ID_RE = /^[0-9A-Z]{26}$/;
const SERVABLE = new Set(['image/png', 'image/gif', 'image/jpeg']);
const tooLarge = () => new ApiError(413, 'too_large', 'Emoji images must be 128 KB or smaller.');
const invalidRequest = () => new ApiError(400, 'invalid_request', 'Send a multipart form with a name and an image.');

/** Reads at most `max` bytes of the body, failing with 413 as soon as more arrive (covers bodies without Content-Length). */
async function readCappedBody(req: Request, max: number): Promise<Uint8Array> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

async function broadcast(env: AppEnv['Bindings'], workspaceId: string, change: { added: CustomEmoji[]; removed: string[] }) {
  try {
    await hubFor(env, workspaceId).emojiChanged(change);
  } catch {
    console.error(JSON.stringify({ level: 'error', code: 'emoji_broadcast_failed' }));
  }
}

const hasBody = (o: R2Object | R2ObjectBody): o is R2ObjectBody => 'body' in o;

emojiRoutes.get('/w/:slug/emoji', requireSession, async (c) => {
  const { workspaceId } = await requireMember(c.env.DB, c.req.param('slug'), c.var.session!.userId);
  return c.json({ emoji: await listCustomEmoji(c.env.DB, workspaceId) });
});

emojiRoutes.post('/w/:slug/emoji', requireSession, async (c) => {
  const db = c.env.DB;
  const userId = c.var.session!.userId;
  const { workspaceId, role } = await requireMember(db, c.req.param('slug'), userId);

  const ws = await db.prepare('SELECT settings_json AS settingsJson FROM workspaces WHERE id = ?').bind(workspaceId).first<{
    settingsJson: string | null;
  }>();
  if (!canAddCustomEmoji(role, readSettings(ws?.settingsJson ?? null))) {
    throw new ApiError(403, 'forbidden', 'Only admins can add custom emoji in this workspace.');
  }

  const contentType = c.req.header('Content-Type') ?? '';
  if (/^application\/json\s*(;|$)/i.test(contentType)) {
    const body = CustomEmojiAliasBody.parse(await readJson(c));
    if (lookupEmoji(body.name)) throw new ApiError(409, 'name_taken', 'That name is used by a built-in emoji.');
    const alias = await createCustomAlias(db, { workspaceId, userId, name: body.name, aliasFor: body.aliasFor, now: c.var.deps.now() });
    await broadcast(c.env, workspaceId, { added: [alias], removed: [] });
    return c.json({ emoji: alias }, 201);
  }

  const declared = Number(c.req.header('Content-Length'));
  if (Number.isFinite(declared) && declared > CUSTOM_EMOJI_UPLOAD_MAX_BYTES) throw tooLarge();

  // The client's Content-Type header is only used to find the multipart boundary.
  if (!/^multipart\/form-data\s*;/i.test(contentType)) throw invalidRequest();
  const body = await readCappedBody(c.req.raw, CUSTOM_EMOJI_UPLOAD_MAX_BYTES);
  let form: FormData;
  try {
    form = await new Response(body, { headers: { 'Content-Type': contentType } }).formData();
  } catch {
    throw invalidRequest();
  }

  const name = form.get('name');
  if (typeof name !== 'string' || !EmojiName.safeParse(name).success) {
    throw new ApiError(400, 'invalid_name', 'Names use 1-32 lowercase letters, digits, "_" or "-".');
  }
  const image = form.get('image');
  if (image === null || typeof image === 'string') throw invalidRequest();
  if (image.size > CUSTOM_EMOJI_MAX_BYTES) throw tooLarge();

  // The file name and declared type are ignored: the stored type comes from the magic bytes only.
  const bytes = new Uint8Array(await image.arrayBuffer());
  const sniffed = sniffImage(bytes);
  if (!sniffed) throw new ApiError(400, 'unsupported_type', 'Use a PNG, GIF or JPEG image.');
  if (sniffed.width < CUSTOM_EMOJI_MIN_SIDE || sniffed.height < CUSTOM_EMOJI_MIN_SIDE) {
    throw new ApiError(400, 'too_small', `Emoji images must be at least ${CUSTOM_EMOJI_MIN_SIDE}×${CUSTOM_EMOJI_MIN_SIDE} pixels.`);
  }
  if (sniffed.width > CUSTOM_EMOJI_MAX_SIDE || sniffed.height > CUSTOM_EMOJI_MAX_SIDE) {
    throw new ApiError(400, 'too_big', `Emoji images must be at most ${CUSTOM_EMOJI_MAX_SIDE}×${CUSTOM_EMOJI_MAX_SIDE} pixels.`);
  }

  if (lookupEmoji(name)) throw new ApiError(409, 'name_taken', 'That name is used by a built-in emoji.');

  const count = await db.prepare('SELECT COUNT(*) AS n FROM custom_emoji WHERE workspace_id = ?').bind(workspaceId).first<{ n: number }>();
  if ((count?.n ?? 0) >= CUSTOM_EMOJI_LIMIT) throw limitReached();

  const emoji = await createCustomEmoji(c.env, { workspaceId, userId, name, bytes, mime: sniffed.mime, now: c.var.deps.now() });

  await broadcast(c.env, workspaceId, { added: [emoji], removed: [] });
  return c.json({ emoji }, 201);
});

emojiRoutes.get('/emoji/:id', requireSession, async (c) => {
  const notFound = new ApiError(404, 'not_found', 'Emoji not found.');
  const id = c.req.param('id');
  if (!ID_RE.test(id)) throw notFound;
  const row = await c.env.DB.prepare(
    `SELECT ce.r2_key AS key FROM custom_emoji ce
     JOIN workspace_members wm ON wm.workspace_id = ce.workspace_id AND wm.user_id = ? AND wm.deactivated_at IS NULL
     WHERE ce.id = ? AND ce.alias_for IS NULL AND ce.r2_key IS NOT NULL`,
  )
    .bind(c.var.session!.userId, id)
    .first<{ key: string }>();
  if (!row) throw notFound;

  const ifNoneMatch = c.req.header('If-None-Match');
  let obj: R2Object | R2ObjectBody | null;
  if (ifNoneMatch) {
    try {
      obj = await c.env.BUCKET.get(row.key, { onlyIf: new Headers({ 'If-None-Match': ifNoneMatch }) });
    } catch {
      // A malformed If-None-Match must not 500 (P3-R16): serve the object unconditionally.
      obj = await c.env.BUCKET.get(row.key);
    }
  } else {
    obj = await c.env.BUCKET.get(row.key);
  }
  if (!obj) throw notFound;

  const stored = obj.httpMetadata?.contentType ?? '';
  const headers = new Headers({
    'Content-Type': SERVABLE.has(stored) ? stored : 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=31536000, immutable',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    ETag: obj.httpEtag,
  });
  // A conditional get whose precondition failed returns the object without a body: the etag matched.
  if (!hasBody(obj)) return new Response(null, { status: 304, headers });
  headers.set('Content-Length', String(obj.size));
  return new Response(obj.body, { status: 200, headers });
});

emojiRoutes.delete('/emoji/:id', requireSession, async (c) => {
  const id = c.req.param('id');
  if (!ID_RE.test(id)) throw new ApiError(404, 'not_found', 'Emoji not found.');
  const { removed, workspaceId } = await deleteCustomEmoji(c.env, { id, userId: c.var.session!.userId });
  await broadcast(c.env, workspaceId, { added: [], removed });
  return c.json({ ok: true });
});
