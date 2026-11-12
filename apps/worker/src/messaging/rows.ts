import type { Message } from '@backroom/protocol';

/**
 * SELECT list aliasing `messages` columns to `Message` field names (also_in_channel is a 0/1 integer).
 * `prefix` qualifies every column (e.g. `'m.'`) for joins; every column is aliased so names never depend on it.
 */
export function messageColumns(prefix = ''): string {
  const p = prefix;
  return `${p}id AS id, ${p}channel_id AS channelId, ${p}seq AS seq, ${p}user_id AS userId, ${p}parent_id AS parentId,
  ${p}body AS body, ${p}also_in_channel AS alsoInChannel, ${p}created_at AS createdAt, ${p}edited_at AS editedAt,
  ${p}deleted_at AS deletedAt, ${p}reply_count AS replyCount, ${p}last_reply_at AS lastReplyAt`;
}

export const MESSAGE_COLUMNS = messageColumns();

export function rowToMessage(row: Record<string, unknown>): Message {
  return { ...(row as Omit<Message, 'alsoInChannel'>), alsoInChannel: Boolean(row.alsoInChannel) };
}
