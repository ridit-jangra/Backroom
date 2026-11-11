import { ApiError } from '../lib/errors';
import { newId } from '../lib/ids';

export const WORKSPACE_SLUG = 'clubhack';
export const GENERAL_CHANNEL_NAME = 'general';

export async function getWorkspaceId(db: D1Database): Promise<string | null> {
  const row = await db.prepare('SELECT id FROM workspaces WHERE slug = ?').bind(WORKSPACE_SLUG).first<{ id: string }>();
  return row?.id ?? null;
}

/**
 * Upserts the user and ensures workspace + #general membership in one batch.
 * Idempotent for existing members; refuses deactivated members and exhausted invites.
 */
export async function acceptLogin(
  db: D1Database,
  rawEmail: string,
  inviteId: string | null,
  ownerEmail: string,
  now: number,
): Promise<{ userId: string }> {
  const email = rawEmail.trim().toLowerCase();
  const workspaceId = await getWorkspaceId(db);
  if (!workspaceId) throw new Error('workspace not found');

  const existing = await db
    .prepare(
      'SELECT wm.deactivated_at FROM workspace_members wm JOIN users u ON u.id = wm.user_id WHERE wm.workspace_id = ? AND u.email = ?',
    )
    .bind(workspaceId, email)
    .first<{ deactivated_at: number | null }>();
  if (existing && existing.deactivated_at !== null) throw new ApiError(403, 'not_allowed', 'This account is deactivated.');
  const isMember = existing !== null;
  const isOwnerEmail = email === ownerEmail.trim().toLowerCase();

  const stmts: D1PreparedStatement[] = [
    db
      .prepare('INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(email) DO NOTHING')
      .bind(newId(now), email, email.split('@')[0], now),
  ];

  if (!isMember) {
    // Role is decided inside the statement (owner only if owner email and no owner row exists
    // at execution time), so workspace_one_owner cannot be violated by this path; the unique
    // index remains a backstop. The row is inserted only if the invite is still valid (or the
    // email is the owner email: it passed eligibility, and falls back to member if an owner exists) and no member row exists yet (PK conflict is a no-op).
    stmts.push(
      db
        .prepare(
          `INSERT INTO workspace_members (workspace_id, user_id, role, joined_at)
           SELECT ?, u.id,
             CASE WHEN ?2 = 1 AND NOT EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ?1 AND role = 'owner')
                  THEN 'owner' ELSE 'member' END,
             ?3
           FROM users u
           WHERE u.email = ?4
             AND (
               EXISTS (SELECT 1 FROM invites WHERE id = ?5 AND workspace_id = ?1 AND expires_at > ?3 AND uses < max_uses)
               OR ?2 = 1
             )
           ON CONFLICT(workspace_id, user_id) DO NOTHING`,
        )
        .bind(workspaceId, isOwnerEmail ? 1 : 0, now, email, inviteId),
    );
    if (inviteId) {
      // changes() reflects the member insert directly above: consume a use only if a row was added.
      stmts.push(
        db
          .prepare('UPDATE invites SET uses = uses + 1 WHERE id = ? AND uses < max_uses AND changes() > 0')
          .bind(inviteId),
      );
    }
  }

  stmts.push(
    db
      .prepare(
        `INSERT OR IGNORE INTO channel_members (channel_id, user_id, last_read_seq, joined_at)
         SELECT c.id, u.id, c.last_seq, ?
         FROM channels c, users u
         WHERE c.workspace_id = ? AND c.name = ? AND u.email = ?
           AND EXISTS (SELECT 1 FROM workspace_members wm WHERE wm.workspace_id = c.workspace_id AND wm.user_id = u.id AND wm.deactivated_at IS NULL)`,
      )
      .bind(now, workspaceId, GENERAL_CHANNEL_NAME, email),
  );

  await db.batch(stmts);

  const user = await db
    .prepare(
      'SELECT u.id FROM users u JOIN workspace_members wm ON wm.user_id = u.id WHERE u.email = ? AND wm.workspace_id = ? AND wm.deactivated_at IS NULL',
    )
    .bind(email, workspaceId)
    .first<{ id: string }>();
  if (!user) throw new ApiError(403, 'not_allowed', 'This invite is no longer valid.');
  return { userId: user.id };
}
