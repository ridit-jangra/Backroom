import type { Role } from '@backroom/protocol';
import { ApiError } from '../lib/errors';

const NOT_FOUND = () => new ApiError(404, 'not_found', 'Workspace not found.');

/** 404 for an unknown slug or a non-member, identically, so slugs cannot be probed. */
export async function requireMember(
  db: D1Database,
  slug: string,
  userId: string,
): Promise<{ workspaceId: string; role: Role }> {
  const row = await db
    .prepare(
      `SELECT w.id AS workspaceId, wm.role AS role
       FROM workspaces w
       JOIN workspace_members wm ON wm.workspace_id = w.id
       WHERE w.slug = ? AND wm.user_id = ? AND wm.deactivated_at IS NULL`,
    )
    .bind(slug, userId)
    .first<{ workspaceId: string; role: Role }>();
  if (!row) throw NOT_FOUND();
  return row;
}

export async function requireAdmin(
  db: D1Database,
  slug: string,
  userId: string,
): Promise<{ workspaceId: string; role: Role }> {
  const m = await requireMember(db, slug, userId);
  if (m.role !== 'owner' && m.role !== 'admin') throw new ApiError(403, 'forbidden', 'Admin access required.');
  return m;
}
