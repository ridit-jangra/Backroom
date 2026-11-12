import { MAX_DISTINCT_REACTIONS, type Message, type NackCode, type ReactionSummary } from '@backroom/protocol';
import { parseReactionCode, resolveBuiltin } from '@backroom/emoji';
import { canSeeChannel } from '../messaging/read';

/** Canonical wire form of a reaction code in a workspace, or null when it names no usable emoji. */
export async function canonicalReaction(db: D1Database, workspaceId: string, code: string): Promise<string | null> {
  const parsed = parseReactionCode(code);
  if (!parsed) return null;
  const builtin = resolveBuiltin(parsed.name, parsed.tone);
  if (builtin) return builtin.canonical;
  if (parsed.tone !== null) return null;
  const row = await db
    .prepare('SELECT alias_for AS aliasFor FROM custom_emoji WHERE workspace_id = ? AND name = ?')
    .bind(workspaceId, parsed.name)
    .first<{ aliasFor: string | null }>();
  if (!row) return null;
  if (row.aliasFor === null) return parsed.name;
  const target = resolveBuiltin(row.aliasFor, null);
  if (target) return target.canonical;
  const t = await db
    .prepare('SELECT 1 AS ok FROM custom_emoji WHERE workspace_id = ? AND name = ? AND alias_for IS NULL')
    .bind(workspaceId, row.aliasFor)
    .first();
  return t ? row.aliasFor : null;
}

export type ToggleResult =
  | { ok: true; channelId: string; emoji: string; changed: boolean }
  | { ok: false; code: NackCode };

export async function toggleReaction(
  db: D1Database,
  input: { messageId: string; userId: string; emoji: string; on: boolean; now: number },
): Promise<ToggleResult> {
  const row = await db
    .prepare(
      `SELECT m.channel_id AS channelId, m.deleted_at AS deletedAt, c.workspace_id AS workspaceId, c.kind AS kind,
              c.archived_at AS archivedAt,
              (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ?2) AS isMember,
              (SELECT wm.role FROM workspace_members wm
                WHERE wm.workspace_id = c.workspace_id AND wm.user_id = ?2 AND wm.deactivated_at IS NULL) AS role
       FROM messages m JOIN channels c ON c.id = m.channel_id WHERE m.id = ?1`,
    )
    .bind(input.messageId, input.userId)
    .first<{
      channelId: string;
      deletedAt: number | null;
      workspaceId: string;
      kind: 'public' | 'private' | 'dm';
      archivedAt: number | null;
      isMember: number | null;
      role: string | null;
    }>();
  if (!row || row.deletedAt !== null || !canSeeChannel(row) || !row.isMember) return { ok: false, code: 'not_found' };
  if (row.archivedAt !== null) return { ok: false, code: 'archived' };

  const canonical = await canonicalReaction(db, row.workspaceId, input.emoji);
  if (canonical === null && input.on) return { ok: false, code: 'invalid' };
  const emoji = canonical ?? input.emoji;

  if (input.on) {
    const res = await db
      .prepare(
        `INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at)
         SELECT ?1, ?2, ?3, ?4
         WHERE EXISTS (SELECT 1 FROM messages WHERE id = ?1 AND deleted_at IS NULL)
           AND (EXISTS (SELECT 1 FROM reactions WHERE message_id = ?1 AND emoji = ?3)
                OR (SELECT COUNT(DISTINCT emoji) FROM reactions WHERE message_id = ?1) < ?5)`,
      )
      .bind(input.messageId, input.userId, emoji, input.now, MAX_DISTINCT_REACTIONS)
      .run();
    if (res.meta.changes > 0) return { ok: true, channelId: row.channelId, emoji, changed: true };
    const mine = await db
      .prepare('SELECT 1 AS ok FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?')
      .bind(input.messageId, input.userId, emoji)
      .first();
    return mine ? { ok: true, channelId: row.channelId, emoji, changed: false } : { ok: false, code: 'invalid' };
  }
  const res = await db
    .prepare('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?')
    .bind(input.messageId, input.userId, emoji)
    .run();
  return { ok: true, channelId: row.channelId, emoji, changed: res.meta.changes > 0 };
}

/** Reaction summaries per message in first-reaction order; one statement however many ids. */
export async function loadReactions(db: D1Database, messageIds: string[]): Promise<Map<string, ReactionSummary[]>> {
  const out = new Map<string, ReactionSummary[]>();
  if (messageIds.length === 0) return out;
  const { results } = await db
    .prepare(
      `SELECT message_id AS messageId, emoji, user_id AS userId FROM reactions
       WHERE message_id IN (SELECT value FROM json_each(?1)) ORDER BY created_at, rowid`,
    )
    .bind(JSON.stringify(messageIds))
    .all<{ messageId: string; emoji: string; userId: string }>();
  for (const r of results) {
    let list = out.get(r.messageId);
    if (!list) out.set(r.messageId, (list = []));
    const found = list.find((s) => s.emoji === r.emoji);
    if (found) found.userIds.push(r.userId);
    else list.push({ emoji: r.emoji, userIds: [r.userId] });
  }
  return out;
}

export async function withReactions(db: D1Database, messages: Message[]): Promise<Message[]> {
  const map = await loadReactions(db, messages.map((m) => m.id));
  return messages.map((m) => ({ ...m, reactions: map.get(m.id) ?? [] }));
}
