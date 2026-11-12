import type { ChannelSummary } from '@backroom/protocol';
import { newId } from '../lib/ids';
import { channelSummaryFor, memberSummaryFor, requireActiveMembers } from './channels';

/**
 * Opens (or returns) the DM whose participants are `userIds` plus the caller. The `dm_key` (sorted
 * IDs joined by `,`) makes it the same channel regardless of who opens it or in which order.
 */
export async function openDm(
  db: D1Database,
  workspaceId: string,
  callerId: string,
  userIds: string[],
  now: number,
): Promise<{ channel: ChannelSummary; created: boolean; participants: string[] }> {
  const participants = [...new Set([...userIds, callerId])].sort();
  await requireActiveMembers(db, workspaceId, participants);
  const dmKey = participants.join(',');
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO channels (id, workspace_id, name, kind, dm_key, created_by, created_at)
         VALUES (?, ?, NULL, 'dm', ?, ?, ?) ON CONFLICT(workspace_id, dm_key) DO NOTHING`,
      )
      .bind(newId(now), workspaceId, dmKey, callerId, now),
    ...participants.map((u) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO channel_members (channel_id, user_id, last_read_seq, joined_at)
           SELECT c.id, ?, c.last_seq, ? FROM channels c WHERE c.workspace_id = ? AND c.dm_key = ?`,
        )
        .bind(u, now, workspaceId, dmKey),
    ),
    db.prepare('SELECT id FROM channels WHERE workspace_id = ? AND dm_key = ?').bind(workspaceId, dmKey),
  ]);
  const created = results[0]!.meta.changes > 0;
  const channelId = (results[results.length - 1]!.results[0] as { id: string }).id;
  const channel = created ? await channelSummaryFor(db, channelId) : await memberSummaryFor(db, channelId, callerId);
  return { channel, created, participants };
}
