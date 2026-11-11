import { newId } from '../lib/ids';

export const WORKSPACE_SLUG = 'clubhack';
export const GENERAL_CHANNEL_NAME = 'general';

export async function getWorkspaceId(db: D1Database): Promise<string | null> {
  const row = await db.prepare('SELECT id FROM workspaces WHERE slug = ?').bind(WORKSPACE_SLUG).first<{ id: string }>();
  return row?.id ?? null;
}

/**
 * Upserts the user and ensures workspace + #general membership in one batch.
 * Expects an already-normalized email. Idempotent for existing members.
 */
export async function acceptLogin(
  db: D1Database,
  email: string,
  inviteId: string | null,
  ownerEmail: string,
  now: number,
): Promise<{ userId: string }> {
  const workspaceId = await getWorkspaceId(db);
  if (!workspaceId) throw new Error('workspace not found');

  const existing = await db
    .prepare('SELECT 1 AS x FROM workspace_members wm JOIN users u ON u.id = wm.user_id WHERE wm.workspace_id = ? AND u.email = ?')
    .bind(workspaceId, email)
    .first();
  const isMember = existing !== null;
  const isOwnerEmail = email === ownerEmail.trim().toLowerCase();

  const userSub = '(SELECT id FROM users WHERE email = ?)';
  const stmts: D1PreparedStatement[] = [
    db
      .prepare('INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(email) DO NOTHING')
      .bind(newId(now), email, email.split('@')[0], now),
  ];

  if (!isMember) {
    // Owner only if no owner exists at execution time; otherwise member. The unique
    // index workspace_one_owner is a backstop; OR IGNORE is handled by the fallback below.
    stmts.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, joined_at)
           VALUES (?, ${userSub},
             CASE WHEN ? = 1 AND NOT EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id = ? AND role = 'owner')
                  THEN 'owner' ELSE 'member' END, ?)`,
        )
        .bind(workspaceId, email, isOwnerEmail ? 1 : 0, workspaceId, now),
    );
    if (inviteId) {
      stmts.push(
        db
          .prepare('UPDATE invites SET uses = uses + 1 WHERE id = ? AND uses < max_uses')
          .bind(inviteId),
      );
    }
  }

  stmts.push(
    db
      .prepare(
        `INSERT OR IGNORE INTO channel_members (channel_id, user_id, last_read_seq, joined_at)
         SELECT c.id, ${userSub}, c.last_seq, ? FROM channels c WHERE c.workspace_id = ? AND c.name = ?`,
      )
      .bind(email, now, workspaceId, GENERAL_CHANNEL_NAME),
  );

  try {
    await db.batch(stmts);
  } catch (e) {
    // Concurrent owner insert tripped workspace_one_owner: retry as plain member.
    if (!isMember && /UNIQUE|constraint/i.test(String((e as Error).message))) {
      await db.batch(
        stmts.map((s, i) =>
          i === 1
            ? db
                .prepare(
                  `INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role, joined_at)
                   VALUES (?, ${userSub}, 'member', ?)`,
                )
                .bind(workspaceId, email, now)
            : s,
        ),
      );
    } else {
      throw e;
    }
  }

  const user = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first<{ id: string }>();
  return { userId: user!.id };
}
