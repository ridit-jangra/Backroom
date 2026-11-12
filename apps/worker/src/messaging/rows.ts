import type { Message } from '@backroom/protocol';

/** SELECT list aliasing `messages` columns to `Message` field names (also_in_channel is a 0/1 integer). */
export const MESSAGE_COLUMNS = `id, channel_id AS channelId, seq, user_id AS userId, parent_id AS parentId, body,
  also_in_channel AS alsoInChannel, created_at AS createdAt, edited_at AS editedAt, deleted_at AS deletedAt,
  reply_count AS replyCount, last_reply_at AS lastReplyAt`;

export function rowToMessage(row: Record<string, unknown>): Message {
  return { ...(row as Omit<Message, 'alsoInChannel'>), alsoInChannel: Boolean(row.alsoInChannel) };
}
