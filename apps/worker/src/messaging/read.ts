import { CATCHUP_LIMIT, type ChannelKind, type HistoryPage, type Message, type ThreadPage } from '@backroom/protocol';
import { ApiError } from '../lib/errors';
import { withReactions } from '../emoji/reactions';
import { withFiles } from '../files/attach';
import { MESSAGE_COLUMNS, rowToMessage } from './rows';

export type ChannelRow = {
  id: string;
  workspaceId: string;
  name: string | null;
  kind: ChannelKind;
  topic: string | null;
  archivedAt: number | null;
  lastSeq: number;
  createdBy: string | null;
  isMember: boolean;
};

/** The single visibility rule: an active workspace member (`role` non-null) who is in the channel or it is public. */
export function canSeeChannel(v: { role: string | null; kind: ChannelKind; isMember: unknown }): boolean {
  return v.role !== null && (v.kind === 'public' || Boolean(v.isMember));
}

/**
 * SQL form of `canSeeChannel` for a channel alias `c` and a bound user parameter (e.g. `'?3'`). It mirrors
 * `canSeeChannel` for an active workspace member only: the caller must already be checked by `requireMember`.
 */
export function VISIBLE_CHANNEL_SQL(c: string, userParam: string): string {
  return `(${c}.kind = 'public' OR EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = ${c}.id AND cm.user_id = ${userParam}))`;
}

export async function requireChannelRead(db: D1Database, channelId: string, userId: string): Promise<ChannelRow> {
  const row = await db
    .prepare(
      `SELECT c.id AS id, c.workspace_id AS workspaceId, c.name AS name, c.kind AS kind, c.topic AS topic,
              c.archived_at AS archivedAt, c.last_seq AS lastSeq, c.created_by AS createdBy,
              (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ?2) AS isMember,
              (SELECT wm.role FROM workspace_members wm
                WHERE wm.workspace_id = c.workspace_id AND wm.user_id = ?2 AND wm.deactivated_at IS NULL) AS role
       FROM channels c WHERE c.id = ?1`,
    )
    .bind(channelId, userId)
    .first<Omit<ChannelRow, 'isMember'> & { isMember: number | null; role: string | null }>();
  if (!row || !canSeeChannel(row)) throw new ApiError(404, 'not_found', 'Channel not found.');
  const { role: _role, ...rest } = row;
  return { ...rest, isMember: Boolean(row.isMember) };
}

const CHANNEL_VIEW = '(parent_id IS NULL OR also_in_channel = 1)';

export async function listMessages(
  db: D1Database,
  channelId: string,
  q: { before?: number; after?: number; limit: number },
): Promise<HistoryPage> {
  const forward = q.after !== undefined;
  const cursor = forward ? 'AND seq > ?' : q.before !== undefined ? 'AND seq < ?' : '';
  const binds: unknown[] = [channelId];
  if (forward) binds.push(q.after);
  else if (q.before !== undefined) binds.push(q.before);
  binds.push(q.limit + 1);
  const { results } = await db
    .prepare(
      `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE channel_id = ? AND ${CHANNEL_VIEW} ${cursor}
       ORDER BY seq ${forward ? 'ASC' : 'DESC'} LIMIT ?`,
    )
    .bind(...binds)
    .all<Record<string, unknown>>();
  const hasMore = results.length > q.limit;
  const page = await withFiles(db, await withReactions(db, results.slice(0, q.limit).map(rowToMessage)));
  return { messages: forward ? page : page.reverse(), hasMore };
}

export const THREAD_LIMIT = 1_000;

export async function getThread(db: D1Database, messageId: string): Promise<ThreadPage | null> {
  const [p, r] = await db.batch([
    db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ? AND parent_id IS NULL`).bind(messageId),
    db
      .prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE parent_id = ? ORDER BY seq ASC LIMIT ${THREAD_LIMIT}`)
      .bind(messageId),
  ]);
  const parent = p!.results[0] as Record<string, unknown> | undefined;
  if (!parent) return null;
  const [pm, ...replies] = await withFiles(
    db,
    await withReactions(db, [rowToMessage(parent), ...(r!.results as Record<string, unknown>[]).map(rowToMessage)]),
  );
  return { parent: pm!, replies };
}

const IN_CHUNK = 90;

export async function catchUp(
  db: D1Database,
  channelIds: string[],
  lastSeen: Record<string, number>,
): Promise<{ messages: Message[]; stale: string[] }> {
  const ids = [...new Set(channelIds)].filter((id) => Object.hasOwn(lastSeen, id));
  if (ids.length === 0) return { messages: [], stale: [] };
  // D1 caps bound parameters at 100 per statement, so the IN list is chunked.
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) chunks.push(ids.slice(i, i + IN_CHUNK));
  const chanSets = await db.batch(
    chunks.map((chunk) =>
      db.prepare(`SELECT id, last_seq AS lastSeq FROM channels WHERE id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk),
    ),
  );
  const lastSeqOf = new Map(
    chanSets.flatMap((s) => (s.results as { id: string; lastSeq: number }[]).map((c) => [c.id, c.lastSeq] as const)),
  );
  const stale: string[] = [];
  const fetch: string[] = [];
  for (const id of ids) {
    const last = lastSeqOf.get(id);
    if (last === undefined) continue;
    if (last - lastSeen[id]! > CATCHUP_LIMIT) stale.push(id);
    else if (last > lastSeen[id]!) fetch.push(id);
  }
  if (fetch.length === 0) return { messages: [], stale };
  const sets = await db.batch(
    fetch.map((id) =>
      db
        .prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE channel_id = ? AND seq > ? ORDER BY seq ASC LIMIT ${CATCHUP_LIMIT}`)
        .bind(id, lastSeen[id]),
    ),
  );
  const messages = await withFiles(
    db,
    await withReactions(db, sets.flatMap((s) => (s.results as Record<string, unknown>[]).map(rowToMessage))),
  );
  return { messages, stale };
}
