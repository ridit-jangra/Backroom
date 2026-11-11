import { z } from 'zod';

export const AuthStartBody = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  inviteToken: z.string().max(100).optional(),
});

export const AuthVerifyBody = z.object({ token: z.string().min(10).max(100) });

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

export type ChannelSummary = {
  id: string;
  name: string | null;
  kind: 'public' | 'private' | 'dm';
  topic: string | null;
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
};

export type Me = { id: string; email: string; displayName: string };

export type Bootstrap = {
  workspace: { id: string; slug: string; name: string };
  me: Me & { role: Role };
  channels: ChannelSummary[];
  members: MemberSummary[];
};

export type InviteSummary = {
  id: string;
  maxUses: number;
  uses: number;
  expiresAt: number;
  createdBy: string;
};
