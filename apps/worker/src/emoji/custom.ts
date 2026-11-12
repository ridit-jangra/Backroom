import { CUSTOM_EMOJI_LIMIT, type CustomEmoji, type WorkspaceSettings } from '@backroom/protocol';
import type { Env } from '../env';
import { ApiError } from '../lib/errors';
import { newId } from '../lib/ids';
import { lookupEmoji } from '@backroom/emoji';
import type { Role } from '@backroom/protocol';

/** `{ customEmojiPolicy: 'admins' }` unless the stored JSON says `'everyone'`; unparseable JSON is the default. */
export function readSettings(json: string | null): WorkspaceSettings {
  if (json) {
    try {
      const parsed: unknown = JSON.parse(json);
      if (typeof parsed === 'object' && parsed !== null && (parsed as Record<string, unknown>).customEmojiPolicy === 'everyone') {
        return { customEmojiPolicy: 'everyone' };
      }
    } catch {
      // fall through to the default
    }
  }
  return { customEmojiPolicy: 'admins' };
}

export type CustomEmojiRow = {
  id: string;
  name: string;
  r2_key: string | null;
  alias_for: string | null;
  created_by: string | null;
  created_at: number;
};

/** A workspace's custom emoji ordered by name, as one statement so callers can put it in a `db.batch` (P3-R6). */
export function customEmojiStatement(db: D1Database, workspaceId: string): D1PreparedStatement {
  return db
    .prepare(
      'SELECT id, name, r2_key, alias_for, created_by, created_at FROM custom_emoji WHERE workspace_id = ? ORDER BY name',
    )
    .bind(workspaceId);
}

export function rowToCustomEmoji(row: CustomEmojiRow): CustomEmoji {
  return {
    id: row.id,
    name: row.name,
    url: row.r2_key ? `/emoji/${row.id}` : null,
    aliasFor: row.alias_for,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export async function listCustomEmoji(db: D1Database, workspaceId: string): Promise<CustomEmoji[]> {
  const { results } = await customEmojiStatement(db, workspaceId).all<CustomEmojiRow>();
  return results.map(rowToCustomEmoji);
}

export function emojiKey(workspaceId: string, emojiId: string): string {
  return `ws/${workspaceId}/emoji/${emojiId}`;
}

const isNameTaken = (e: unknown) =>
  e instanceof Error && /UNIQUE constraint failed: custom_emoji\.workspace_id, custom_emoji\.name/.test(e.message);

/**
 * Stores the image in R2, then inserts the row. The insert re-checks the per-workspace limit so
 * concurrent uploads cannot pass it. On any insert failure the object is deleted again.
 */
export async function createCustomEmoji(
  env: Env,
  input: { workspaceId: string; userId: string; name: string; bytes: Uint8Array; mime: string; now: number },
): Promise<CustomEmoji> {
  const id = newId(input.now);
  const key = emojiKey(input.workspaceId, id);
  await env.BUCKET.put(key, input.bytes, { httpMetadata: { contentType: input.mime } });
  let inserted: boolean;
  try {
    const r = await env.DB.prepare(
      `INSERT INTO custom_emoji (id, workspace_id, name, r2_key, alias_for, created_by, created_at)
       SELECT ?1, ?2, ?3, ?4, NULL, ?5, ?6
       WHERE (SELECT COUNT(*) FROM custom_emoji WHERE workspace_id = ?2) < ?7`,
    )
      .bind(id, input.workspaceId, input.name, key, input.userId, input.now, CUSTOM_EMOJI_LIMIT)
      .run();
    inserted = r.meta.changes === 1;
  } catch (e) {
    await cleanupObject(env, key);
    if (isNameTaken(e)) throw new ApiError(409, 'name_taken', 'A custom emoji with that name already exists.');
    throw e;
  }
  if (!inserted) {
    await cleanupObject(env, key);
    throw limitReached();
  }
  return rowToCustomEmoji({
    id,
    name: input.name,
    r2_key: key,
    alias_for: null,
    created_by: input.userId,
    created_at: input.now,
  });
}

export const limitReached = () =>
  new ApiError(400, 'limit_reached', `A workspace can have at most ${CUSTOM_EMOJI_LIMIT.toLocaleString('en-US')} custom emoji.`);

/** Best-effort R2 delete: a failure is logged (no key, no ids) and never replaces the error the caller is about to raise. */
async function cleanupObject(env: Env, key: string): Promise<void> {
  await env.BUCKET.delete(key).catch(() => {
    console.error(JSON.stringify({ level: 'error', code: 'r2_cleanup_failed' }));
  });
}

const invalidAlias = () => new ApiError(400, 'invalid_alias', 'Alias target not found.');

/** Inserts an alias row (no image). The target is a built-in (stored by its primary name) or an existing non-alias custom emoji. */
export async function createCustomAlias(
  db: D1Database,
  input: { workspaceId: string; userId: string; name: string; aliasFor: string; now: number },
): Promise<CustomEmoji> {
  const builtin = lookupEmoji(input.aliasFor);
  const target = builtin ? builtin.names[0]! : input.aliasFor;
  const id = newId(input.now);
  let changes: number;
  try {
    const r = await db
      .prepare(
        `INSERT INTO custom_emoji (id, workspace_id, name, r2_key, alias_for, created_by, created_at)
         SELECT ?1, ?2, ?3, NULL, ?4, ?5, ?6
         WHERE (SELECT COUNT(*) FROM custom_emoji WHERE workspace_id = ?2) < ?7
           AND (?8 = 1 OR EXISTS (SELECT 1 FROM custom_emoji WHERE workspace_id = ?2 AND name = ?4 AND alias_for IS NULL))`,
      )
      .bind(id, input.workspaceId, input.name, target, input.userId, input.now, CUSTOM_EMOJI_LIMIT, builtin ? 1 : 0)
      .run();
    changes = r.meta.changes;
  } catch (e) {
    if (isNameTaken(e)) throw new ApiError(409, 'name_taken', 'A custom emoji with that name already exists.');
    throw e;
  }
  if (changes !== 1) {
    const n = await db.prepare('SELECT COUNT(*) AS n FROM custom_emoji WHERE workspace_id = ?').bind(input.workspaceId).first<{ n: number }>();
    if ((n?.n ?? 0) >= CUSTOM_EMOJI_LIMIT) throw limitReached();
    throw invalidAlias();
  }
  return rowToCustomEmoji({ id, name: input.name, r2_key: null, alias_for: target, created_by: input.userId, created_at: input.now });
}

/** Removes an emoji and every alias of it in one batch, then its R2 object. 404 unless the caller is an active member; 403 unless creator/admin/owner. */
export async function deleteCustomEmoji(
  env: Env,
  input: { id: string; userId: string },
): Promise<{ removed: string[]; workspaceId: string }> {
  const row = await env.DB.prepare(
    `SELECT ce.id AS id, ce.workspace_id AS workspaceId, ce.name AS name, ce.r2_key AS r2Key, ce.alias_for AS aliasFor,
            ce.created_by AS createdBy, wm.role AS role
     FROM custom_emoji ce
     JOIN workspace_members wm ON wm.workspace_id = ce.workspace_id AND wm.user_id = ? AND wm.deactivated_at IS NULL
     WHERE ce.id = ?`,
  )
    .bind(input.userId, input.id)
    .first<{ id: string; workspaceId: string; name: string; r2Key: string | null; aliasFor: string | null; createdBy: string | null; role: Role }>();
  if (!row) throw new ApiError(404, 'not_found', 'Emoji not found.');
  if (row.createdBy !== input.userId && row.role !== 'owner' && row.role !== 'admin') {
    throw new ApiError(403, 'forbidden', 'Only the creator or an admin can delete this emoji.');
  }

  // P3-R7: aliases are scoped to the emoji's workspace. An alias row itself has no aliases of its own.
  const { results: aliases } = await env.DB.prepare('SELECT id, r2_key AS r2Key FROM custom_emoji WHERE workspace_id = ? AND alias_for = ?')
    .bind(row.workspaceId, row.name)
    .all<{ id: string; r2Key: string | null }>();
  const aliasRows = row.aliasFor === null ? aliases : [];
  await env.DB.batch([
    env.DB.prepare('DELETE FROM custom_emoji WHERE id = ?').bind(row.id),
    env.DB.prepare('DELETE FROM custom_emoji WHERE workspace_id = ? AND alias_for = ?').bind(row.workspaceId, row.aliasFor === null ? row.name : ''),
  ]);
  const keys = [row.r2Key, ...aliasRows.map((a) => a.r2Key)].filter((k): k is string => k !== null);
  for (const k of keys) await cleanupObject(env, k);
  return { removed: [row.id, ...aliasRows.map((a) => a.id)], workspaceId: row.workspaceId };
}
