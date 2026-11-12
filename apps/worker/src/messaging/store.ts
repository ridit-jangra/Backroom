import { extractMentions, type ChannelKind, type Message, type NackCode, type ParsedMentions } from '@backroom/protocol';
import { newId } from '../lib/ids';
import { MESSAGE_COLUMNS, rowToMessage } from './rows';

export type MemberNotify = { userId: string; notify: 'all' | 'mentions' | 'none' };
export type Audience = {
  kind: ChannelKind;
  members: MemberNotify[];
  followers: string[];
  /** `userIds` already filtered to channel members other than the author. */
  mentions: ParsedMentions;
};
export type SendInput = {
  clientId: string;
  channelId: string;
  userId: string;
  parentId: string | null;
  body: string;
  alsoInChannel: boolean;
  fileIds: string[];
  now: number;
};
type Fail = { ok: false; code: NackCode };

function keptMentions(body: string, members: MemberNotify[], authorId: string): ParsedMentions {
  const m = extractMentions(body);
  const ids = new Set(members.map((x) => x.userId));
  return { ...m, userIds: m.userIds.filter((u) => ids.has(u) && u !== authorId) };
}

function mentionStatements(db: D1Database, messageId: string, m: ParsedMentions): D1PreparedStatement[] {
  const ins = 'INSERT INTO mentions (message_id, user_id, kind) VALUES (?, ?, ?)';
  return [
    ...m.userIds.map((u) => db.prepare(ins).bind(messageId, u, 'user')),
    ...(m.channel ? [db.prepare(ins).bind(messageId, null, 'channel')] : []),
    ...(m.here ? [db.prepare(ins).bind(messageId, null, 'here')] : []),
  ];
}

type Context = {
  channel: { kind: ChannelKind; archivedAt: number | null } | null;
  members: MemberNotify[];
  parent: { channelId: string; parentId: string | null } | null;
  followers: string[];
};

/** One round trip: channel, all members, the parent (if any) and its thread followers. */
async function loadContext(db: D1Database, channelId: string, parentId: string | null): Promise<Context> {
  const stmts = [
    db.prepare('SELECT kind, archived_at AS archivedAt FROM channels WHERE id = ?').bind(channelId),
    db
      .prepare(
        `SELECT cm.user_id AS userId, cm.notify AS notify
         FROM channel_members cm
         JOIN channels c ON c.id = cm.channel_id
         JOIN workspace_members wm ON wm.workspace_id = c.workspace_id AND wm.user_id = cm.user_id AND wm.deactivated_at IS NULL
         WHERE cm.channel_id = ?`,
      )
      .bind(channelId),
  ];
  if (parentId) {
    stmts.push(
      db.prepare('SELECT channel_id AS channelId, parent_id AS parentId FROM messages WHERE id = ?').bind(parentId),
      db.prepare('SELECT user_id AS userId FROM thread_follows WHERE message_id = ?').bind(parentId),
    );
  }
  const r = await db.batch(stmts);
  return {
    channel: (r[0]!.results[0] as Context['channel']) ?? null,
    members: r[1]!.results as MemberNotify[],
    parent: parentId ? ((r[2]!.results[0] as Context['parent']) ?? null) : null,
    followers: parentId ? (r[3]!.results as { userId: string }[]).map((x) => x.userId) : [],
  };
}

async function loadMessage(db: D1Database, id: string): Promise<Message | null> {
  const row = await db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`).bind(id).first<Record<string, unknown>>();
  return row ? rowToMessage(row) : null;
}

export async function sendMessage(
  db: D1Database,
  input: SendInput,
): Promise<{ ok: true; message: Message; duplicate: boolean; audience: Audience } | Fail> {
  if (input.fileIds.length > 0) return { ok: false, code: 'invalid' };
  const existing = await findDuplicate(db, input);
  if (existing) return existing;
  const ctx = await loadContext(db, input.channelId, input.parentId);
  if (!ctx.channel || !ctx.members.some((m) => m.userId === input.userId)) return { ok: false, code: 'not_found' };
  if (ctx.channel.archivedAt !== null) return { ok: false, code: 'archived' };
  if (input.parentId && (!ctx.parent || ctx.parent.channelId !== input.channelId || ctx.parent.parentId !== null)) {
    return { ok: false, code: 'invalid' };
  }

  const audience: Audience = {
    kind: ctx.channel.kind,
    members: ctx.members,
    followers: ctx.followers,
    mentions: keptMentions(input.body, ctx.members, input.userId),
  };
  const id = newId(input.now);
  const root = input.parentId ?? id;
  const alsoInChannel = input.parentId !== null && input.alsoInChannel;
  const seqOf = '(SELECT seq FROM messages WHERE id = ?)';
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO messages (id, channel_id, seq, user_id, parent_id, body, also_in_channel, created_at, client_id)
         SELECT ?, id, last_seq + 1, ?, ?, ?, ?, ?, ? FROM channels WHERE id = ?`,
      )
      .bind(id, input.userId, input.parentId, input.body, alsoInChannel ? 1 : 0, input.now, input.clientId, input.channelId),
    db.prepare('UPDATE channels SET last_seq = last_seq + 1 WHERE id = ?').bind(input.channelId),
    ...mentionStatements(db, id, audience.mentions),
  ];
  if (input.parentId) {
    stmts.push(
      db.prepare('UPDATE messages SET reply_count = reply_count + 1, last_reply_at = ? WHERE id = ?').bind(input.now, input.parentId),
    );
  }
  stmts.push(
    db
      .prepare('INSERT OR IGNORE INTO thread_follows (message_id, user_id, last_read_reply_seq) VALUES (?, ?, 0)')
      .bind(root, input.userId),
  );
  if (input.parentId) {
    stmts.push(
      db
        .prepare(`UPDATE thread_follows SET last_read_reply_seq = ${seqOf} WHERE message_id = ? AND user_id = ?`)
        .bind(id, input.parentId, input.userId),
    );
  }
  if (!input.parentId || alsoInChannel) {
    stmts.push(
      db
        .prepare(
          `UPDATE channel_members SET last_read_seq = MAX(last_read_seq, ${seqOf}) WHERE channel_id = ? AND user_id = ?`,
        )
        .bind(id, input.channelId, input.userId),
    );
  }

  try {
    await db.batch(stmts);
  } catch {
    return (await findDuplicate(db, input)) ?? { ok: false, code: 'failed' };
  }
  const message = await loadMessage(db, id);
  if (!message) return { ok: false, code: 'failed' };
  return { ok: true, message, duplicate: false, audience };
}

/** A prior send with the same (user, clientId): returns the original with a freshly loaded audience. */
async function findDuplicate(
  db: D1Database,
  input: SendInput,
): Promise<{ ok: true; message: Message; duplicate: true; audience: Audience } | null> {
  const dup = await db
    .prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE user_id = ? AND client_id = ?`)
    .bind(input.userId, input.clientId)
    .first<Record<string, unknown>>();
  if (!dup) return null;
  const message = rowToMessage(dup);
  const fresh = await loadContext(db, message.channelId, message.parentId);
  return {
    ok: true,
    message,
    duplicate: true,
    audience: {
      kind: fresh.channel?.kind ?? 'public',
      members: fresh.members,
      followers: fresh.followers,
      mentions: keptMentions(message.body, fresh.members, input.userId),
    },
  };
}

type Target = {
  id: string;
  userId: string;
  deletedAt: number | null;
  channelId: string;
  kind: ChannelKind;
  isMember: number | null;
  role: string | null;
};

/** Visibility first (not_found), so authors/roles are never revealed for messages the caller cannot see. */
async function loadTarget(db: D1Database, messageId: string, userId: string): Promise<Target | null> {
  const row = await db
    .prepare(
      `SELECT m.id AS id, m.user_id AS userId, m.deleted_at AS deletedAt, m.channel_id AS channelId, c.kind AS kind,
              (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ?2) AS isMember,
              (SELECT wm.role FROM workspace_members wm
                WHERE wm.workspace_id = c.workspace_id AND wm.user_id = ?2 AND wm.deactivated_at IS NULL) AS role
       FROM messages m JOIN channels c ON c.id = m.channel_id WHERE m.id = ?1`,
    )
    .bind(messageId, userId)
    .first<Target>();
  if (!row || row.deletedAt !== null || row.role === null) return null;
  if (row.kind !== 'public' && !row.isMember) return null;
  return row;
}

export async function editMessage(
  db: D1Database,
  input: { messageId: string; userId: string; body: string; now: number },
): Promise<{ ok: true; message: Message } | Fail> {
  const t = await loadTarget(db, input.messageId, input.userId);
  if (!t) return { ok: false, code: 'not_found' };
  if (t.userId !== input.userId) return { ok: false, code: 'forbidden' };
  const { members } = await loadContext(db, t.channelId, null);
  const mentions = keptMentions(input.body, members, input.userId);
  await db.batch([
    db.prepare('UPDATE messages SET body = ?, edited_at = ? WHERE id = ? AND deleted_at IS NULL').bind(input.body, input.now, input.messageId),
    db.prepare('DELETE FROM mentions WHERE message_id = ?').bind(input.messageId),
    ...mentionStatements(db, input.messageId, mentions),
  ]);
  const message = await loadMessage(db, input.messageId);
  return message ? { ok: true, message } : { ok: false, code: 'failed' };
}

export async function deleteMessage(
  db: D1Database,
  input: { messageId: string; userId: string; now: number },
): Promise<{ ok: true; message: Message } | Fail> {
  const t = await loadTarget(db, input.messageId, input.userId);
  if (!t) return { ok: false, code: 'not_found' };
  if (t.userId !== input.userId && t.role !== 'owner' && t.role !== 'admin') return { ok: false, code: 'forbidden' };
  await db.batch([
    db.prepare("UPDATE messages SET deleted_at = ?, body = '' WHERE id = ? AND deleted_at IS NULL").bind(input.now, input.messageId),
    db.prepare('DELETE FROM mentions WHERE message_id = ?').bind(input.messageId),
  ]);
  const message = await loadMessage(db, input.messageId);
  return message ? { ok: true, message } : { ok: false, code: 'failed' };
}
