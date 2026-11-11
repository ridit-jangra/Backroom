import type { Bootstrap, ChannelSummary, MemberSummary, Me, Role } from '@backroom/protocol';
import { requireMember } from './access';

const DISPLAY = "COALESCE(u.display_name, substr(u.email, 1, instr(u.email, '@') - 1))";

export async function getMe(db: D1Database, userId: string): Promise<Me> {
  const row = await db
    .prepare(`SELECT u.id AS id, u.email AS email, ${DISPLAY} AS displayName FROM users u WHERE u.id = ?`)
    .bind(userId)
    .first<Me>();
  if (!row) throw new Error('user not found');
  return row;
}

export async function getBootstrap(db: D1Database, slug: string, userId: string): Promise<Bootstrap> {
  const { workspaceId, role } = await requireMember(db, slug, userId);

  const [ws, me, channels, members] = await db.batch([
    db.prepare('SELECT id, slug, name FROM workspaces WHERE id = ?').bind(workspaceId),
    db.prepare(`SELECT u.id AS id, u.email AS email, ${DISPLAY} AS displayName FROM users u WHERE u.id = ?`).bind(userId),
    db
      .prepare(
        `SELECT c.id AS id, c.name AS name, c.kind AS kind, c.topic AS topic,
                c.last_seq AS lastSeq, cm.last_read_seq AS lastReadSeq,
                (SELECT COUNT(*) FROM messages m
                  WHERE m.channel_id = c.id AND m.seq > cm.last_read_seq AND m.deleted_at IS NULL
                    AND (m.parent_id IS NULL OR m.also_in_channel = 1)) AS unreadCount,
                (SELECT COUNT(*) FROM messages m
                  WHERE m.channel_id = c.id AND m.seq > cm.last_read_seq AND m.deleted_at IS NULL
                    AND (m.parent_id IS NULL OR m.also_in_channel = 1)
                    AND EXISTS (SELECT 1 FROM mentions mn WHERE mn.message_id = m.id
                                AND (mn.user_id = ?1 OR mn.kind IN ('channel', 'here')))) AS mentionCount
         FROM channels c
         JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = ?1
         WHERE c.workspace_id = ?2 AND c.archived_at IS NULL
         ORDER BY (c.kind = 'dm'), CASE WHEN c.kind = 'dm' THEN NULL ELSE LOWER(c.name) END, c.id`,
      )
      .bind(userId, workspaceId),
    db
      .prepare(
        `SELECT u.id AS id, ${DISPLAY} AS displayName, wm.role AS role, u.avatar_key AS avatarKey
         FROM workspace_members wm JOIN users u ON u.id = wm.user_id
         WHERE wm.workspace_id = ? AND wm.deactivated_at IS NULL
         ORDER BY LOWER(${DISPLAY}), u.id`,
      )
      .bind(workspaceId),
  ]);

  return {
    workspace: ws!.results[0] as { id: string; slug: string; name: string },
    me: { ...(me!.results[0] as Me), role: role as Role },
    channels: channels!.results as ChannelSummary[],
    members: members!.results as MemberSummary[],
  };
}
