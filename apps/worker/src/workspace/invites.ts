import type { InviteSummary, MemberSummary, Role } from '@backroom/protocol';
import { randomToken, sha256Hex } from '../lib/crypto';
import { ApiError } from '../lib/errors';
import { newId } from '../lib/ids';
import { requireAdmin } from './access';

const DAY_MS = 86_400_000;
const ROW = 'id, max_uses AS maxUses, uses, expires_at AS expiresAt, created_by AS createdBy';

export async function createInvite(
  db: D1Database,
  workspaceId: string,
  createdBy: string,
  opts: { maxUses: number; expiresInDays: number },
  now: number,
): Promise<{ invite: InviteSummary; token: string }> {
  const token = randomToken();
  const invite: InviteSummary = {
    id: newId(now),
    maxUses: opts.maxUses,
    uses: 0,
    expiresAt: now + opts.expiresInDays * DAY_MS,
    createdBy,
  };
  await db
    .prepare('INSERT INTO invites (id, workspace_id, token_hash, created_by, expires_at, max_uses, uses) VALUES (?, ?, ?, ?, ?, ?, 0)')
    .bind(invite.id, workspaceId, await sha256Hex(token), createdBy, invite.expiresAt, invite.maxUses)
    .run();
  return { invite, token };
}

export async function listInvites(db: D1Database, workspaceId: string, now: number): Promise<InviteSummary[]> {
  const { results } = await db
    .prepare(`SELECT ${ROW} FROM invites WHERE workspace_id = ? AND expires_at > ? AND uses < max_uses ORDER BY id`)
    .bind(workspaceId, now)
    .all<InviteSummary>();
  return results;
}

/** Admin of the invite's workspace revokes it by expiring it now. */
export async function revokeInvite(db: D1Database, inviteId: string, userId: string, now: number): Promise<void> {
  const row = await db
    .prepare('SELECT w.slug AS slug FROM invites i JOIN workspaces w ON w.id = i.workspace_id WHERE i.id = ?')
    .bind(inviteId)
    .first<{ slug: string }>();
  if (!row) throw new ApiError(404, 'not_found', 'Invite not found.');
  await requireAdmin(db, row.slug, userId);
  await db.prepare('UPDATE invites SET expires_at = ? WHERE id = ?').bind(now, inviteId).run();
}

export async function patchMember(
  db: D1Database,
  slug: string,
  actorId: string,
  targetId: string,
  patch: { role?: 'admin' | 'member'; deactivated?: boolean },
  now: number,
): Promise<MemberSummary> {
  const actor = await requireAdmin(db, slug, actorId);
  const target = await db
    .prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
    .bind(actor.workspaceId, targetId)
    .first<{ role: Role }>();
  if (!target) throw new ApiError(404, 'not_found', 'Member not found.');
  if (target.role === 'owner') throw new ApiError(403, 'forbidden', 'The owner cannot be changed.');
  if (patch.role !== undefined && actor.role !== 'owner') {
    throw new ApiError(403, 'forbidden', 'Only the owner can change roles.');
  }
  if (patch.deactivated === true && targetId === actorId) {
    throw new ApiError(403, 'forbidden', 'You cannot deactivate yourself.');
  }

  // All writes land together or not at all.
  const writes: D1PreparedStatement[] = [];
  if (patch.role !== undefined) {
    writes.push(
      db
        .prepare('UPDATE workspace_members SET role = ? WHERE workspace_id = ? AND user_id = ?')
        .bind(patch.role, actor.workspaceId, targetId),
    );
  }
  if (patch.deactivated !== undefined) {
    writes.push(
      db
        .prepare('UPDATE workspace_members SET deactivated_at = ? WHERE workspace_id = ? AND user_id = ?')
        .bind(patch.deactivated ? now : null, actor.workspaceId, targetId),
    );
    // Same statement as deleteAllSessions, batched with the deactivation.
    if (patch.deactivated) writes.push(db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(targetId));
  }
  if (writes.length > 0) await db.batch(writes);

  const member = await db
    .prepare(
      `SELECT u.id AS id, COALESCE(u.display_name, substr(u.email, 1, instr(u.email, '@') - 1)) AS displayName,
              wm.role AS role, u.avatar_key AS avatarKey
       FROM workspace_members wm JOIN users u ON u.id = wm.user_id
       WHERE wm.workspace_id = ? AND wm.user_id = ?`,
    )
    .bind(actor.workspaceId, targetId)
    .first<MemberSummary>();
  return member!;
}
