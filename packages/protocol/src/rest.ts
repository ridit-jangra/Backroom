import { z } from 'zod';
import type { CustomEmoji, WorkspaceSettings } from './emoji';

export const AuthStartBody = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  inviteToken: z.string().max(100).optional(),
  desktopChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
});

export const AuthVerifyBody = z.object({ token: z.string().min(10).max(100) });

export const DesktopExchangeBody = z.object({
  code: z.string().min(10).max(100),
  verifier: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

export const InviteCreateBody = z.object({
  maxUses: z.number().int().min(1).max(500).default(50),
  expiresInDays: z.number().int().min(1).max(90).default(14),
});

export const MemberPatchBody = z.object({
  role: z.enum(['admin', 'member']).optional(),
  deactivated: z.boolean().optional(),
});

export const MePatchBody = z.object({ displayName: z.string().trim().min(1).max(80) });

export type ApiErrorBody = { error: { code: string; message: string } };

export type Role = 'owner' | 'admin' | 'member';

export type ChannelKind = 'public' | 'private' | 'dm';

export type ChannelSummary = {
  id: string;
  name: string | null;
  kind: ChannelKind;
  topic: string | null;
  createdBy: string | null;
  /** Sorted member IDs for kind 'dm', otherwise null. */
  dmUserIds: string[] | null;
  lastSeq: number;
  lastReadSeq: number;
  unreadCount: number;
  mentionCount: number;
};

export type MemberSummary = {
  id: string;
  displayName: string;
  role: Role;
  avatarKey: string | null;
  /** Set (true) only for deactivated members, listed so their messages keep a name (P2-R28). */
  deactivated?: true;
};

export type Me = { id: string; email: string; displayName: string };

export type Bootstrap = {
  workspace: { id: string; slug: string; name: string; settings?: WorkspaceSettings };
  me: Me & { role: Role };
  channels: ChannelSummary[];
  members: MemberSummary[];
  /** Omitted when the request's `?emojiRev=` matches `emojiRev` (P3-R20): keep the held list. */
  customEmoji?: CustomEmoji[];
  /** P3-R20: revision of the custom emoji list; send it back as `?emojiRev=` on the next bootstrap. */
  emojiRev?: number;
  /** R11 (Phase 6): admins and owners only; when sign-in email last failed to send (epoch ms). */
  emailFailedAt?: number;
};

export type InviteSummary = {
  id: string;
  maxUses: number;
  uses: number;
  expiresAt: number;
  createdBy: string;
};
