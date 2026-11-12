import { z } from 'zod';
import {
  ChannelInfoSchema,
  ChannelSummarySchema,
  Id,
  MAX_BODY,
  MessageSchema,
  NackCodeSchema,
  NotifyKindSchema,
  PresenceStateSchema,
} from './messaging';
import { MAX_FILES_PER_MESSAGE } from './files';
import { CustomEmojiSchema, ReactionCode } from './emoji';

const Body = z
  .string()
  .max(MAX_BODY)
  .refine((s) => s.trim().length > 0, { message: 'body must not be blank' });
const ClientId = z.string().min(8).max(64);
const Seq = z.number().int().min(0);

export const ClientFrame = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('hello'),
    lastSeen: z
      .record(Id, Seq)
      .refine((r) => Object.keys(r).length <= 500, { message: 'too many channels' }),
  }),
  z.object({
    t: z.literal('send'),
    clientId: ClientId,
    channelId: Id,
    parentId: Id.optional(),
    body: z.string().max(MAX_BODY),
    fileIds: z.array(Id).max(MAX_FILES_PER_MESSAGE).optional(),
    alsoInChannel: z.boolean().optional(),
  }),
  z.object({ t: z.literal('edit'), messageId: Id, body: Body, clientId: ClientId.optional() }),
  z.object({ t: z.literal('delete'), messageId: Id, clientId: ClientId.optional() }),
  z.object({ t: z.literal('react'), messageId: Id, emoji: ReactionCode, on: z.boolean(), clientId: ClientId.optional() }),
  z.object({ t: z.literal('mark_read'), channelId: Id, seq: Seq }),
  z.object({ t: z.literal('mark_thread_read'), messageId: Id, seq: Seq }),
  z.object({ t: z.literal('typing'), channelId: Id, parentId: Id.optional() }),
  z.object({ t: z.literal('activity') }),
  z.object({ t: z.literal('ping') }),
]).superRefine((f, ctx) => {
  if (f.t === 'send' && f.body.trim().length === 0 && (f.fileIds === undefined || f.fileIds.length === 0)) {
    ctx.addIssue({ code: 'custom', path: ['body'], message: 'body must not be blank' });
  }
});
export type ClientFrame = z.infer<typeof ClientFrame>;

export type ParsedClientFrame =
  | { ok: true; frame: ClientFrame }
  | { ok: false; clientId?: string; code: 'invalid' | 'too_long' };

export function parseClientFrame(raw: string): ParsedClientFrame {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, code: 'invalid' };
  }
  const r = ClientFrame.safeParse(json);
  if (r.success) return { ok: true, frame: r.data };
  const rawClientId =
    typeof json === 'object' && json !== null && typeof (json as { clientId?: unknown }).clientId === 'string'
      ? (json as { clientId: string }).clientId
      : undefined;
  const tooLong =
    r.error.issues.length > 0 &&
    r.error.issues.every((i) => i.code === 'too_big' && i.path[i.path.length - 1] === 'body');
  const code = tooLong ? 'too_long' : 'invalid';
  return rawClientId !== undefined ? { ok: false, clientId: rawClientId, code } : { ok: false, code };
}

const PresenceEntry = z.object({ userId: z.string(), state: PresenceStateSchema });

export const HubFrame = z.union([
  z.object({ t: z.literal('ack'), clientId: z.string(), message: MessageSchema }),
  z.object({ t: z.literal('nack'), clientId: z.string(), code: NackCodeSchema }),
  z.object({ t: z.literal('message.new'), message: MessageSchema }),
  z.object({ t: z.literal('message.edit'), message: MessageSchema }),
  z.object({ t: z.literal('message.delete'), message: MessageSchema }),
  z.object({ t: z.literal('read'), channelId: z.string(), seq: z.number().int() }),
  z.object({ t: z.literal('channel.update'), channel: ChannelInfoSchema }),
  z.object({ t: z.literal('membership'), action: z.literal('added'), channel: ChannelSummarySchema }),
  z.object({ t: z.literal('membership'), action: z.literal('removed'), channelId: z.string() }),
  z.object({ t: z.literal('presence'), userId: z.string(), state: PresenceStateSchema }),
  z.object({ t: z.literal('typing'), channelId: z.string(), userId: z.string(), parentId: z.string().optional() }),
  z.object({
    t: z.literal('notify'),
    kind: NotifyKindSchema,
    channelId: z.string(),
    messageId: z.string(),
    parentId: z.string().nullable(),
    fromUserId: z.string(),
    preview: z.string(),
  }),
  z.object({ t: z.literal('catchup'), messages: z.array(MessageSchema), presence: z.array(PresenceEntry) }),
  z.object({ t: z.literal('stale'), channelId: z.string() }),
  z.object({
    t: z.literal('reaction'),
    channelId: z.string(),
    messageId: z.string(),
    emoji: z.string(),
    userId: z.string(),
    on: z.boolean(),
  }),
  z.object({ t: z.literal('emoji.update'), added: z.array(CustomEmojiSchema), removed: z.array(z.string()) }),
  z.object({ t: z.literal('pong') }),
]);
export type HubFrame = z.infer<typeof HubFrame>;

export function parseHubFrame(raw: string): HubFrame | null {
  try {
    const r = HubFrame.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}
