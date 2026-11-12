import type { Message, NotifyKind } from '@backroom/protocol';
import type { Audience } from './store';

/**
 * Who gets a `notify` frame for a stored message: one entry per member other than the author,
 * first matching rule wins (spec §5, P2-R18 for `all`).
 */
export function notifyTargets(
  audience: Audience,
  message: Message,
  isActive: (userId: string) => boolean,
): { userId: string; kind: NotifyKind }[] {
  const mentioned = new Set(audience.mentions.userIds);
  const followers = new Set(audience.followers);
  const out: { userId: string; kind: NotifyKind }[] = [];
  for (const m of audience.members) {
    if (m.userId === message.userId) continue;
    let kind: NotifyKind | null = null;
    if (audience.kind === 'dm') kind = 'dm';
    else if (mentioned.has(m.userId)) kind = 'mention';
    else if (message.parentId !== null && followers.has(m.userId)) kind = 'thread';
    else if (audience.mentions.channel && m.notify !== 'none') kind = 'channel';
    else if (audience.mentions.here && m.notify !== 'none' && isActive(m.userId)) kind = 'here';
    else if (message.parentId === null && m.notify === 'all') kind = 'all';
    if (kind) out.push({ userId: m.userId, kind });
  }
  return out;
}
