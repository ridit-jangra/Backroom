import type { Bootstrap, MemberSummary, Me, Role } from '@backroom/protocol';
import { SUMMARY_COLUMNS, rowToSummary, type SummaryRow } from '../channels/channels';
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
        `SELECT ${SUMMARY_COLUMNS}
         FROM channels c
         JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = ?1
         WHERE c.workspace_id = ?2 AND c.archived_at IS NULL
         ORDER BY (c.kind = 'dm'), CASE WHEN c.kind = 'dm' THEN NULL ELSE LOWER(c.name) END, c.id`,
      )
      .bind(userId, workspaceId),
    db
      .prepare(
        `SELECT u.id AS id, ${DISPLAY} AS displayName, wm.role AS role, u.avatar_key AS avatarKey,
                (wm.deactivated_at IS NOT NULL) AS deactivated
         FROM workspace_members wm JOIN users u ON u.id = wm.user_id
         WHERE wm.workspace_id = ?
         ORDER BY LOWER(${DISPLAY}), u.id`,
      )
      .bind(workspaceId),
  ]);

  return {
    workspace: ws!.results[0] as { id: string; slug: string; name: string },
    me: { ...(me!.results[0] as Me), role: role as Role },
    channels: (channels!.results as SummaryRow[]).map(rowToSummary),
    // P2-R28: deactivated members stay listed (flagged) so their old messages keep a name.
    members: (members!.results as (Omit<MemberSummary, 'deactivated'> & { deactivated: number })[]).map(({ deactivated, ...m }) =>
      deactivated ? { ...m, deactivated: true } : m,
    ),
  };
}
