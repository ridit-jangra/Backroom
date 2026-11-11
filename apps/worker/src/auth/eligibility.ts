import { sha256Hex } from '../lib/crypto';
import { getWorkspaceId } from '../workspace/membership';

export type Eligibility = { ok: false } | { ok: true; inviteId: string | null };

const NO: Eligibility = { ok: false };

async function evaluate(
  db: D1Database,
  email: string,
  invite: { by: 'hash'; value: string | null } | { by: 'id'; value: string | null },
  ownerEmail: string,
  now: number,
): Promise<Eligibility> {
  const workspaceId = await getWorkspaceId(db);
  if (!workspaceId) return NO;

  const member = await db
    .prepare(
      'SELECT wm.deactivated_at FROM workspace_members wm JOIN users u ON u.id = wm.user_id WHERE wm.workspace_id = ? AND u.email = ?',
    )
    .bind(workspaceId, email)
    .first<{ deactivated_at: number | null }>();
  if (member) return member.deactivated_at === null ? { ok: true, inviteId: null } : NO;

  // (b) valid invite
  if (invite.value !== null) {
    const col = invite.by === 'hash' ? 'token_hash' : 'id';
    const row = await db
      .prepare(`SELECT id FROM invites WHERE ${col} = ? AND workspace_id = ? AND expires_at > ? AND uses < max_uses`)
      .bind(invite.value, workspaceId, now)
      .first<{ id: string }>();
    if (row) return { ok: true, inviteId: row.id };
  }

  // (c) owner bootstrap
  if (email === ownerEmail.trim().toLowerCase()) {
    const owner = await db
      .prepare("SELECT 1 AS x FROM workspace_members WHERE workspace_id = ? AND role = 'owner' LIMIT 1")
      .bind(workspaceId)
      .first();
    if (!owner) return { ok: true, inviteId: null };
  }
  return NO;
}

export async function checkEligibility(
  db: D1Database,
  email: string,
  inviteToken: string | undefined,
  ownerEmail: string,
  now: number,
): Promise<Eligibility> {
  const value = inviteToken ? await sha256Hex(inviteToken) : null;
  return evaluate(db, email, { by: 'hash', value }, ownerEmail, now);
}

export async function checkEligibilityByInviteId(
  db: D1Database,
  email: string,
  inviteId: string | null,
  ownerEmail: string,
  now: number,
): Promise<Eligibility> {
  return evaluate(db, email, { by: 'id', value: inviteId }, ownerEmail, now);
}
