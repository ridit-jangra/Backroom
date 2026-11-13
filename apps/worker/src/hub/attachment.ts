import type { PresenceState } from '@backroom/protocol';
import type { FrameBudget } from './budget';

/** Per-socket state, serialized onto the WebSocket so it survives hibernation (spec §5). */
export type SocketAttachment = {
  userId: string;
  workspaceId: string;
  channelIds: string[];
  lastActivityAt: number;
  announced: PresenceState;
  /** Phase 6 per-socket frame budget; absent until the first counted frame (a full bucket). */
  budget?: FrameBudget;
};

export function getAtt(ws: WebSocket): SocketAttachment {
  return ws.deserializeAttachment() as SocketAttachment;
}

export function setAtt(ws: WebSocket, a: SocketAttachment): void {
  ws.serializeAttachment(a);
}

/* Channel-set accessors (P2-R5): later tasks read and change a socket's channels only through these,
   so the backing store can move off the attachment without touching callers. */

export function channelsOf(ws: WebSocket): string[] {
  return getAtt(ws).channelIds;
}

export function addChannel(ws: WebSocket, channelId: string): void {
  const a = getAtt(ws);
  if (!a.channelIds.includes(channelId)) setAtt(ws, { ...a, channelIds: [...a.channelIds, channelId] });
}

export function removeChannel(ws: WebSocket, channelId: string): void {
  const a = getAtt(ws);
  if (a.channelIds.includes(channelId)) setAtt(ws, { ...a, channelIds: a.channelIds.filter((id) => id !== channelId) });
}
