import type { ChannelKind } from '@backroom/protocol';
import { canSeeChannel } from '../messaging/read';

/** What a download needs once access is granted. */
export type FileAccess = { id: string; r2Key: string; thumbKey: string | null; name: string; mime: string; size: number };

type AccessRow = FileAccess & {
  role: string | null;
  uploaderId: string;
  messageId: string | null;
  deletedAt: number | null;
  kind: ChannelKind | null;
  isMember: unknown;
};

/**
 * §8 download rule. The caller must be an active member of the file's workspace (`role` non-null), and then either
 * - the file is unattached and the caller uploaded it, or
 * - the referencing message is not deleted and the caller can see its channel (`canSeeChannel`).
 */
export function canDownload(
  r: { role: string | null; uploaderId: string; messageId: string | null; deletedAt: number | null; kind: ChannelKind | null; isMember: unknown },
  userId: string,
): boolean {
  if (r.role === null) return false;
  if (r.messageId === null) return r.uploaderId === userId;
  // kind is null only if the link points at a missing message/channel: never visible.
  return r.deletedAt === null && r.kind !== null && canSeeChannel({ role: r.role, kind: r.kind, isMember: r.isMember });
}

/**
 * One query: the file, its (at most one, unique index) message link, the message and channel, the caller's channel
 * membership and their active role in the file's workspace. Returns the row only when `canDownload` holds, so
 * "does not exist" and "not visible" are indistinguishable to the caller.
 */
export async function loadFileAccess(db: D1Database, fileId: string, userId: string): Promise<FileAccess | null> {
  const row = await db
    .prepare(
      `SELECT f.id AS id, f.r2_key AS r2Key, f.thumb_key AS thumbKey, f.name AS name, f.mime AS mime, f.size AS size,
              f.uploader_id AS uploaderId, mf.message_id AS messageId, m.deleted_at AS deletedAt, c.kind AS kind,
              (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ?2) AS isMember,
              (SELECT wm.role FROM workspace_members wm
                WHERE wm.workspace_id = f.workspace_id AND wm.user_id = ?2 AND wm.deactivated_at IS NULL) AS role
       FROM files f
       LEFT JOIN message_files mf ON mf.file_id = f.id
       LEFT JOIN messages m ON m.id = mf.message_id
       LEFT JOIN channels c ON c.id = m.channel_id AND c.workspace_id = f.workspace_id
       WHERE f.id = ?1`,
    )
    .bind(fileId, userId)
    .first<AccessRow>();
  if (!row || !canDownload(row, userId)) return null;
  return { id: row.id, r2Key: row.r2Key, thumbKey: row.thumbKey, name: row.name, mime: row.mime, size: row.size };
}
