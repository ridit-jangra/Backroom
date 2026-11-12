import type { ChannelSummary, HubFrame, MemberSummary } from '@backroom/protocol';
import { tokenize } from './text/tokenize';

export type NotifyFrame = Extract<HubFrame, { t: 'notify' }>;

function api(): typeof Notification | undefined {
  return typeof Notification === 'undefined' ? undefined : Notification;
}

export function notificationPermission(): NotificationPermission | 'unsupported' {
  return api()?.permission ?? 'unsupported';
}

/** Show a browser notification unless the user is looking at the channel or permission is missing. */
export function showNotification(
  n: NotifyFrame,
  ctx: { viewing: boolean; title: string; body: string; onClick: () => void },
): boolean {
  const N = api();
  if (ctx.viewing || !N || N.permission !== 'granted') return false;
  try {
    const note = new N(ctx.title, { body: ctx.body, tag: n.messageId });
    note.onclick = () => {
      window.focus();
      ctx.onClick();
    };
    return true;
  } catch {
    return false;
  }
}

/** Only ever call from a user gesture (click handler). */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  const N = api();
  if (!N) return 'denied';
  return N.requestPermission();
}

/** Message body as plain text: mention tokens become `@Name`. */
export function plainText(body: string, members: MemberSummary[]): string {
  const names = new Map(members.map((m) => [m.id, m.displayName]));
  return tokenize(body)
    .map((t) => {
      switch (t.kind) {
        case 'text':
        case 'link':
          return t.text;
        case 'user':
          return `@${names.get(t.userId) ?? 'unknown'}`;
        case 'broadcast':
          return `@${t.which}`;
      }
    })
    .join('');
}

/** Sidebar/notification label: `#name`, or DM participants other than me (my own name for a self-DM). */
export function channelLabel(c: ChannelSummary, members: MemberSummary[], me: string): string {
  if (c.kind !== 'dm') return `#${c.name ?? ''}`;
  const names = new Map(members.map((m) => [m.id, m.displayName]));
  const ids = c.dmUserIds ?? [];
  const others = ids.filter((u) => u !== me);
  const shown = others.length > 0 ? others : [me];
  return shown.map((u) => names.get(u) ?? 'Unknown').join(', ');
}

export function notificationText(
  n: NotifyFrame,
  ctx: { channels: Record<string, ChannelSummary>; members: MemberSummary[]; me: string },
): { title: string; body: string } {
  const body = plainText(n.preview, ctx.members);
  if (n.kind === 'dm') {
    const sender = ctx.members.find((m) => m.id === n.fromUserId)?.displayName ?? 'Direct message';
    return { title: sender, body };
  }
  const c = ctx.channels[n.channelId];
  return { title: c ? channelLabel(c, ctx.members, ctx.me) : 'New message', body };
}
