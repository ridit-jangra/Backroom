import { MAX_FILES_PER_MESSAGE, ORPHAN_TTL_MS, type FileInfo, type Message } from '@backroom/protocol';
import { FILE_INFO_COLUMNS, rowToFileInfo, type FileInfoRow } from './store';

/**
 * A file this close to the orphan TTL is no longer attachable (P4-R8): the 1 h margin means the cron can never
 * delete a file between its validation and the send batch that links it.
 */
const ATTACH_MAX_AGE_MS = ORPHAN_TTL_MS - 3_600_000;

/**
 * The infos of `fileIds` (ordered by id) when every id is a distinct, existing, unattached upload of `userId` in
 * `workspaceId` that is younger than `ATTACH_MAX_AGE_MS`; otherwise null. One statement however many ids.
 */
export async function validateAttachments(
  db: D1Database,
  input: { fileIds: string[]; userId: string; workspaceId: string; now: number },
): Promise<FileInfo[] | null> {
  const { fileIds } = input;
  if (fileIds.length > MAX_FILES_PER_MESSAGE || new Set(fileIds).size !== fileIds.length) return null;
  if (fileIds.length === 0) return [];
  const { results } = await db
    .prepare(
      `SELECT ${FILE_INFO_COLUMNS}, uploader_id AS uploaderId, workspace_id AS workspaceId, created_at AS createdAt,
              EXISTS (SELECT 1 FROM message_files mf WHERE mf.file_id = files.id) AS attached
       FROM files WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id`,
    )
    .bind(JSON.stringify(fileIds))
    .all<FileInfoRow & { uploaderId: string; workspaceId: string; createdAt: number; attached: number }>();
  if (results.length !== fileIds.length) return null;
  const minCreatedAt = input.now - ATTACH_MAX_AGE_MS;
  for (const r of results) {
    if (r.uploaderId !== input.userId || r.workspaceId !== input.workspaceId || r.attached || r.createdAt <= minCreatedAt) {
      return null;
    }
  }
  return results.map(rowToFileInfo);
}

/** One link insert per file; the unique `message_files(file_id)` index makes a racing double attach fail the batch. */
export function fileLinkStatements(db: D1Database, messageId: string, fileIds: string[]): D1PreparedStatement[] {
  return fileIds.map((f) => db.prepare('INSERT INTO message_files (message_id, file_id) VALUES (?, ?)').bind(messageId, f));
}

/** Attached file infos per message, ordered by file id; one statement however many ids, none for no ids. */
export async function loadFileInfos(db: D1Database, messageIds: string[]): Promise<Map<string, FileInfo[]>> {
  const out = new Map<string, FileInfo[]>();
  if (messageIds.length === 0) return out;
  const { results } = await db
    .prepare(
      `SELECT mf.message_id AS messageId, ${FILE_INFO_COLUMNS}
       FROM message_files mf JOIN files f ON f.id = mf.file_id
       WHERE mf.message_id IN (SELECT value FROM json_each(?)) ORDER BY f.id`,
    )
    .bind(JSON.stringify(messageIds))
    .all<FileInfoRow & { messageId: string }>();
  for (const r of results) {
    let list = out.get(r.messageId);
    if (!list) out.set(r.messageId, (list = []));
    list.push(rowToFileInfo(r));
  }
  return out;
}

/** Sets authoritative `files` on every message: `[]` for deleted messages and messages without files. */
export async function withFiles(db: D1Database, messages: Message[]): Promise<Message[]> {
  const live = messages.filter((m) => m.deletedAt === null).map((m) => m.id);
  const map = await loadFileInfos(db, live);
  return messages.map((m) => ({ ...m, files: m.deletedAt === null ? (map.get(m.id) ?? []) : [] }));
}
