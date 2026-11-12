import type { ChannelInfo, ChannelKind, ChannelListing, ChannelSummary, Role } from '@backroom/protocol';
import { ApiError } from '../lib/errors';
import { newId } from '../lib/ids';
import { requireChannelRead, type ChannelRow } from '../messaging/read';
import { GENERAL_CHANNEL_NAME } from '../workspace/membership';

/** P2-R27: unread/mention counts are capped so a long-unread channel costs at most this many rows. */
export const COUNT_CAP = 100;

/**
 * Columns of one member's ChannelSummary row. The query must alias `channels` as `c` and that
 * member's `channel_members` row as `cm` (the counts are for `cm.user_id`, capped at COUNT_CAP). Shared with bootstrap.
 */
export const SUMMARY_COLUMNS = `c.id AS id, c.name AS name, c.kind AS kind, c.topic AS topic,
  c.created_by AS createdBy, c.dm_key AS dmKey,
  c.last_seq AS lastSeq, cm.last_read_seq AS lastReadSeq,
  (SELECT COUNT(*) FROM (SELECT 1 FROM messages m
    WHERE m.channel_id = c.id AND m.seq > cm.last_read_seq AND m.deleted_at IS NULL
      AND (m.parent_id IS NULL OR m.also_in_channel = 1)
    LIMIT ${COUNT_CAP})) AS unreadCount,
  (SELECT COUNT(*) FROM (SELECT 1 FROM messages m
    WHERE m.channel_id = c.id AND m.seq > cm.last_read_seq AND m.deleted_at IS NULL
      AND (m.parent_id IS NULL OR m.also_in_channel = 1)
      AND EXISTS (SELECT 1 FROM mentions mn WHERE mn.message_id = m.id
                  AND (mn.user_id = cm.user_id OR (mn.kind IN ('channel', 'here') AND m.user_id <> cm.user_id)))
    LIMIT ${COUNT_CAP})) AS mentionCount`;

export type SummaryRow = Omit<ChannelSummary, 'dmUserIds'> & { dmKey: string | null };

export function rowToSummary({ dmKey, ...c }: SummaryRow): ChannelSummary {
  return { ...c, dmUserIds: c.kind === 'dm' && dmKey ? dmKey.split(',') : null };
}

const notFound = () => new ApiError(404, 'not_found', 'Channel not found.');
const forbidden = (message: string) => new ApiError(403, 'forbidden', message);
const nameTaken = () => new ApiError(409, 'name_taken', 'That channel name is taken.');
const invalidUser = () => new ApiError(400, 'invalid_user', 'Every user must be an active member of this workspace.');

/** Only the UNIQUE(workspace_id, name) constraint on channels means "name taken". */
function isNameTaken(e: unknown): boolean {
  return e instanceof Error && /UNIQUE constraint failed: channels\.workspace_id, channels\.name/.test(e.message);
}

function isGeneral(ch: { kind: ChannelKind; name: string | null }): boolean {
  return ch.kind === 'public' && ch.name === GENERAL_CHANNEL_NAME;
}

/** The summary a just-joined member sees: everything read (`lastReadSeq = lastSeq`), zero counts. */
export async function channelSummaryFor(db: D1Database, channelId: string): Promise<ChannelSummary> {
  const row = await db
    .prepare(
      `SELECT id, name, kind, topic, created_by AS createdBy, dm_key AS dmKey, last_seq AS lastSeq
       FROM channels WHERE id = ?`,
    )
    .bind(channelId)
    .first<Omit<SummaryRow, 'lastReadSeq' | 'unreadCount' | 'mentionCount'>>();
  if (!row) throw notFound();
  return rowToSummary({ ...row, lastReadSeq: row.lastSeq, unreadCount: 0, mentionCount: 0 });
}

/** The caller's real summary (own read position and counts) for a channel they already belong to. */
export async function memberSummaryFor(db: D1Database, channelId: string, userId: string): Promise<ChannelSummary> {
  const row = await db
    .prepare(
      `SELECT ${SUMMARY_COLUMNS} FROM channels c
       JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = ?1
       WHERE c.id = ?2`,
    )
    .bind(userId, channelId)
    .first<SummaryRow>();
  if (!row) throw notFound();
  return rowToSummary(row);
}

/** Each member's own summary (as bootstrap would give it), in one D1 batch. Non-members are omitted. */
export async function memberSummariesFor(
  db: D1Database,
  channelId: string,
  userIds: string[],
): Promise<Record<string, ChannelSummary>> {
  const ids = [...new Set(userIds)];
  // One statement per chunk (D1 caps bound parameters at 100), not one per user.
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += 90) chunks.push(ids.slice(i, i + 90));
  if (chunks.length === 0) return {};
  const sets = await db.batch(
    chunks.map((chunk) =>
      db
        .prepare(
          `SELECT cm.user_id AS userId, ${SUMMARY_COLUMNS} FROM channels c
           JOIN channel_members cm ON cm.channel_id = c.id
           WHERE c.id = ? AND cm.user_id IN (${chunk.map(() => '?').join(',')})`,
        )
        .bind(channelId, ...chunk),
    ),
  );
  const out: Record<string, ChannelSummary> = {};
  for (const set of sets) {
    for (const { userId, ...row } of set.results as (SummaryRow & { userId: string })[]) out[userId] = rowToSummary(row);
  }
  return out;
}

function toInfo(ch: { id: string; name: string | null; kind: ChannelKind; topic: string | null; archivedAt: number | null }): ChannelInfo {
  return { id: ch.id, name: ch.name, kind: ch.kind, topic: ch.topic, archivedAt: ch.archivedAt };
}

/** Active workspace members of a channel. */
export async function activeMemberIds(db: D1Database, channelId: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT cm.user_id AS id FROM channel_members cm
       JOIN channels c ON c.id = cm.channel_id
       JOIN workspace_members wm ON wm.workspace_id = c.workspace_id AND wm.user_id = cm.user_id AND wm.deactivated_at IS NULL
       WHERE cm.channel_id = ?`,
    )
    .bind(channelId)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

/** Throws `400 invalid_user` unless every ID is an active member of the workspace. */
export async function requireActiveMembers(db: D1Database, workspaceId: string, userIds: string[]): Promise<void> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return;
  const { results } = await db
    .prepare(
      `SELECT user_id AS id FROM workspace_members
       WHERE workspace_id = ? AND deactivated_at IS NULL AND user_id IN (${ids.map(() => '?').join(',')})`,
    )
    .bind(workspaceId, ...ids)
    .all<{ id: string }>();
  if (results.length !== ids.length) throw invalidUser();
}

/** A channel the caller can see and belongs to (public non-member: `403 not_member`; otherwise 404). */
async function requireChannelMember(db: D1Database, channelId: string, userId: string): Promise<ChannelRow> {
  const ch = await requireChannelRead(db, channelId, userId);
  if (!ch.isMember) throw new ApiError(403, 'not_member', 'Join this channel first.');
  return ch;
}

/** Non-archived public channels plus the caller's private channels, ordered by name. */
export async function listChannels(db: D1Database, workspaceId: string, userId: string): Promise<ChannelListing[]> {
  const { results } = await db
    .prepare(
      `SELECT c.id AS id, c.name AS name, c.kind AS kind, c.topic AS topic, c.archived_at AS archivedAt,
              (SELECT COUNT(*) FROM channel_members m
                 JOIN workspace_members wm ON wm.workspace_id = c.workspace_id AND wm.user_id = m.user_id
                                           AND wm.deactivated_at IS NULL
                WHERE m.channel_id = c.id) AS memberCount,
              EXISTS (SELECT 1 FROM channel_members m WHERE m.channel_id = c.id AND m.user_id = ?2) AS isMember
       FROM channels c
       WHERE c.workspace_id = ?1 AND c.archived_at IS NULL
         AND (c.kind = 'public'
              OR (c.kind = 'private' AND EXISTS (SELECT 1 FROM channel_members m WHERE m.channel_id = c.id AND m.user_id = ?2)))
       ORDER BY c.name, c.id`,
    )
    .bind(workspaceId, userId)
    .all<Omit<ChannelListing, 'isMember'> & { isMember: number }>();
  return results.map((r) => ({ ...r, isMember: Boolean(r.isMember) }));
}

export async function createChannel(
  db: D1Database,
  workspaceId: string,
  userId: string,
  body: { name: string; private: boolean; topic?: string },
  now: number,
): Promise<ChannelSummary> {
  const id = newId(now);
  try {
    await db.batch([
      db
        .prepare('INSERT INTO channels (id, workspace_id, name, kind, topic, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(id, workspaceId, body.name, body.private ? 'private' : 'public', body.topic || null, userId, now),
      db
        .prepare('INSERT INTO channel_members (channel_id, user_id, last_read_seq, joined_at) VALUES (?, ?, 0, ?)')
        .bind(id, userId, now),
    ]);
  } catch (e) {
    // UNIQUE(workspace_id, name) covers archived channels too.
    if (isNameTaken(e)) throw nameTaken();
    throw e;
  }
  return channelSummaryFor(db, id);
}

export async function patchChannel(
  db: D1Database,
  channelId: string,
  userId: string,
  patch: { name?: string; topic?: string; archived?: boolean },
  now: number,
): Promise<{ channel: ChannelInfo; workspaceId: string }> {
  const ch = await requireChannelMember(db, channelId, userId);
  if (ch.kind === 'dm') throw forbidden('Direct messages have no settings.');
  if (patch.name !== undefined || patch.archived !== undefined) {
    if (isGeneral(ch)) throw forbidden('#general cannot be renamed or archived.');
    if (ch.createdBy !== userId) {
      const m = await db
        .prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND deactivated_at IS NULL')
        .bind(ch.workspaceId, userId)
        .first<{ role: Role }>();
      if (m?.role !== 'owner' && m?.role !== 'admin') {
        throw forbidden('Only the channel creator or a workspace admin can do that.');
      }
    }
  }
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.name !== undefined) {
    sets.push('name = ?');
    binds.push(patch.name);
  }
  if (patch.topic !== undefined) {
    sets.push('topic = ?');
    binds.push(patch.topic === '' ? null : patch.topic);
  }
  if (patch.archived !== undefined) {
    sets.push(patch.archived ? 'archived_at = COALESCE(archived_at, ?)' : 'archived_at = NULL');
    if (patch.archived) binds.push(now);
  }
  let row: ChannelInfo | null;
  try {
    row = await db
      .prepare(
        `UPDATE channels SET ${sets.join(', ')} WHERE id = ?
         RETURNING id, name, kind, topic, archived_at AS archivedAt`,
      )
      .bind(...binds, channelId)
      .first<ChannelInfo>();
  } catch (e) {
    if (isNameTaken(e)) throw nameTaken();
    throw e;
  }
  if (!row) throw notFound();
  return { channel: toInfo(row), workspaceId: ch.workspaceId };
}

/** Joins a non-archived public channel. `joined` is false when the caller already belonged to it. */
export async function joinChannel(
  db: D1Database,
  channelId: string,
  userId: string,
  now: number,
): Promise<{ channel: ChannelSummary; joined: boolean; workspaceId: string }> {
  const ch = await requireChannelRead(db, channelId, userId);
  // Same body as an unknown ID, so private channels cannot be probed.
  if (ch.kind !== 'public' || ch.archivedAt !== null) throw notFound();
  if (ch.isMember) return { channel: await memberSummaryFor(db, channelId, userId), joined: false, workspaceId: ch.workspaceId };
  const r = await db
    .prepare(
      `INSERT OR IGNORE INTO channel_members (channel_id, user_id, last_read_seq, joined_at)
       SELECT id, ?, last_seq, ? FROM channels WHERE id = ?`,
    )
    .bind(userId, now, channelId)
    .run();
  if (r.meta.changes === 0) {
    return { channel: await memberSummaryFor(db, channelId, userId), joined: false, workspaceId: ch.workspaceId };
  }
  return { channel: await channelSummaryFor(db, channelId), joined: true, workspaceId: ch.workspaceId };
}

/**
 * Leaves a channel. `beforeDelete` runs after the checks and before the row is deleted (the route
 * updates the hub there). `left` is false when the caller was not a member.
 */
export async function leaveChannel(
  db: D1Database,
  channelId: string,
  userId: string,
  beforeDelete: (workspaceId: string) => Promise<void> = async () => {},
): Promise<{ left: boolean; workspaceId: string }> {
  const ch = await requireChannelRead(db, channelId, userId);
  if (ch.kind === 'dm' || isGeneral(ch)) {
    throw new ApiError(403, 'cannot_leave', ch.kind === 'dm' ? 'You cannot leave a direct message.' : 'Everyone stays in #general.');
  }
  await beforeDelete(ch.workspaceId);
  const r = await db.prepare('DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?').bind(channelId, userId).run();
  return { left: r.meta.changes > 0, workspaceId: ch.workspaceId };
}

/** Adds active workspace members to a channel the caller belongs to; returns the newly added IDs. */
export async function addMembers(
  db: D1Database,
  channelId: string,
  actorId: string,
  userIds: string[],
  now: number,
): Promise<{ added: string[]; members: string[]; workspaceId: string }> {
  const ch = await requireChannelMember(db, channelId, actorId);
  if (ch.kind === 'dm') throw forbidden('Direct messages cannot take new members.');
  if (ch.archivedAt !== null) throw forbidden('This channel is archived.');
  const ids = [...new Set(userIds)];
  await requireActiveMembers(db, ch.workspaceId, ids);
  const results = await db.batch(
    ids.map((u) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO channel_members (channel_id, user_id, last_read_seq, joined_at)
           SELECT c.id, ?2, c.last_seq, ?3 FROM channels c
           WHERE c.id = ?1
             AND EXISTS (SELECT 1 FROM workspace_members wm
                         WHERE wm.workspace_id = c.workspace_id AND wm.user_id = ?2 AND wm.deactivated_at IS NULL)`,
        )
        .bind(channelId, u, now),
    ),
  );
  // `members`: every requested ID (all are members now); `added`: those this request inserted.
  return { added: ids.filter((_, i) => results[i]!.meta.changes > 0), members: ids, workspaceId: ch.workspaceId };
}
