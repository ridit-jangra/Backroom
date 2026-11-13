import { z } from 'zod';
import type { ChannelKind, MemberSummary } from './rest';
import { ReactionSummarySchema } from './emoji';
import { FileInfoSchema } from './files';

export const MAX_BODY = 40_000;
export const CATCHUP_LIMIT = 200;
export const HISTORY_DEFAULT = 50;
export const HISTORY_MAX = 100;
export const RESEND_AFTER_MS = 10_000;
export const ACTIVE_WINDOW_MS = 600_000;
export const TYPING_THROTTLE_MS = 3_000;
export const TYPING_TTL_MS = 5_000;
export const MARK_READ_INTERVAL_MS = 1_000;
export const PING_FRAME = '{"t":"ping"}';
export const PONG_FRAME = '{"t":"pong"}';

export const Id = z.string().regex(/^[0-9A-Z]{26}$/);

export const ChannelKindSchema = z.enum(['public', 'private', 'dm']);

export const MessageSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  seq: z.number().int(),
  userId: z.string(),
  parentId: z.string().nullable(),
  body: z.string(),
  alsoInChannel: z.boolean(),
  createdAt: z.number(),
  editedAt: z.number().nullable(),
  deletedAt: z.number().nullable(),
  replyCount: z.number().int(),
  lastReplyAt: z.number().nullable(),
  /** Absent = unknown (keep what you hold); [] = none. */
  reactions: z.array(ReactionSummarySchema).optional(),
  /** Absent = unknown (keep what you hold); [] = none. */
  files: z.array(FileInfoSchema).optional(),
});
export type Message = z.infer<typeof MessageSchema>;

export const ChannelInfoSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  kind: ChannelKindSchema,
  topic: z.string().nullable(),
  archivedAt: z.number().nullable(),
});
export type ChannelInfo = { id: string; name: string | null; kind: ChannelKind; topic: string | null; archivedAt: number | null };

export type ChannelListing = ChannelInfo & { memberCount: number; isMember: boolean };
export type HistoryPage = { messages: Message[]; hasMore: boolean };
export type ThreadPage = { parent: Message; replies: Message[] };
export type AdminMember = MemberSummary & { deactivatedAt: number | null };

export const ChannelSummarySchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  kind: ChannelKindSchema,
  topic: z.string().nullable(),
  createdBy: z.string().nullable(),
  dmUserIds: z.array(z.string()).nullable(),
  lastSeq: z.number().int(),
  lastReadSeq: z.number().int(),
  unreadCount: z.number().int(),
  mentionCount: z.number().int(),
});

// REST bodies
export const ChannelName = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_-]{0,79}$/);

export const ChannelCreateBody = z.object({
  name: ChannelName,
  private: z.boolean().default(false),
  topic: z.string().trim().max(250).optional(),
});

export const ChannelPatchBody = z
  .object({
    name: ChannelName.optional(),
    topic: z.string().trim().max(250).optional(),
    archived: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'at least one field required' });

export const ChannelMembersBody = z.object({ userIds: z.array(Id).min(1).max(50) });
export const DmOpenBody = z.object({ userIds: z.array(Id).min(1).max(8) });

export const HistoryQuery = z
  .object({
    before: z.coerce.number().int().min(1).optional(),
    after: z.coerce.number().int().min(0).optional(),
    limit: z.coerce.number().int().min(1).max(HISTORY_MAX).default(HISTORY_DEFAULT),
  })
  .refine((v) => v.before === undefined || v.after === undefined, { message: 'before and after are mutually exclusive' });

/** `rate_limited` (Phase 6): the socket's frame budget is spent; the frame was not processed. */
export type NackCode = 'invalid' | 'too_long' | 'not_found' | 'forbidden' | 'archived' | 'failed' | 'rate_limited';
export type PresenceState = 'active' | 'away';
export type NotifyKind = 'dm' | 'mention' | 'thread' | 'channel' | 'here' | 'all';

export const NackCodeSchema = z.enum(['invalid', 'too_long', 'not_found', 'forbidden', 'archived', 'failed', 'rate_limited']);
export const PresenceStateSchema = z.enum(['active', 'away']);
export const NotifyKindSchema = z.enum(['dm', 'mention', 'thread', 'channel', 'here', 'all']);
