/** Custom emoji name: also the stored form of a custom reaction. */
export const EMOJI_NAME_RE = /^[a-z0-9_-]{1,32}$/;
/** Wire reaction code (no surrounding colons): `name` or `name::skin-tone-N`, N in 2-6. */
export const REACTION_CODE_RE = /^[a-z0-9_+-]{1,64}(::skin-tone-[2-6])?$/;

import { z } from 'zod';
import type { Role } from './rest';

export const CUSTOM_EMOJI_MAX_BYTES = 131_072;
/** File plus multipart overhead. */
export const CUSTOM_EMOJI_UPLOAD_MAX_BYTES = 139_264;
export const CUSTOM_EMOJI_MIN_SIDE = 32;
export const CUSTOM_EMOJI_MAX_SIDE = 4_096;
export const CUSTOM_EMOJI_LIMIT = 2_000;
/** P6-R10: custom emoji image uploads per workspace per UTC day (each is one KV write; aliases are free). */
export const CUSTOM_EMOJI_DAILY_LIMIT = 200;
export const MAX_DISTINCT_REACTIONS = 50;

export const EmojiName = z.string().regex(EMOJI_NAME_RE);
export const ReactionCode = z.string().regex(REACTION_CODE_RE);

export type CustomEmojiPolicy = 'admins' | 'everyone';
export type WorkspaceSettings = { customEmojiPolicy: CustomEmojiPolicy };
export const WorkspaceSettingsPatchBody = z.object({ customEmojiPolicy: z.enum(['admins', 'everyone']) });

export function canAddCustomEmoji(role: Role, settings: WorkspaceSettings | undefined): boolean {
  if (role === 'owner' || role === 'admin') return true;
  return settings?.customEmojiPolicy === 'everyone';
}

export const CustomEmojiSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** '/emoji/<id>'; null for aliases. */
  url: z.string().nullable(),
  aliasFor: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.number(),
});
export type CustomEmoji = z.infer<typeof CustomEmojiSchema>;

export const CustomEmojiAliasBody = z.object({
  name: EmojiName,
  aliasFor: z.string().regex(/^[a-z0-9_+-]{1,64}$/),
});

/** userIds in reaction order; summaries ordered by first reaction. */
export const ReactionSummarySchema = z.object({ emoji: z.string(), userIds: z.array(z.string()) });
export type ReactionSummary = z.infer<typeof ReactionSummarySchema>;
