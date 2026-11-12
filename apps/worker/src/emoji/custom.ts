import { CUSTOM_EMOJI_LIMIT, type CustomEmoji, type WorkspaceSettings } from '@backroom/protocol';
import type { Env } from '../env';
import { ApiError } from '../lib/errors';
import { newId } from '../lib/ids';

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
    await env.BUCKET.delete(key);
    if (isNameTaken(e)) throw new ApiError(409, 'name_taken', 'A custom emoji with that name already exists.');
    throw e;
  }
  if (!inserted) {
    await env.BUCKET.delete(key);
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
