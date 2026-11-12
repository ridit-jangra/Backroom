import { DurableObject } from 'cloudflare:workers';
import {
  ACTIVE_WINDOW_MS,
  PING_FRAME,
  PONG_FRAME,
  parseClientFrame,
  type ClientFrame,
  type HubFrame,
  type Message,
  type PresenceState,
} from '@backroom/protocol';
import type { Env } from '../env';
import { catchUp } from '../messaging/read';
import { channelsOf, getAtt, setAtt } from './attachment';

const MAX_FRAME_CHARS = 262_144;
/**
 * Upper bound (bytes of serialized JSON) for the messages in one `catchup` frame. A channel whose
 * missed messages would push the frame past it is sent as `stale` instead (the client refetches it
 * over REST), so one frame can never exceed the WebSocket message limit.
 */
export const CATCHUP_FRAME_BUDGET = 1_000_000;

const utf8 = new TextEncoder();

/** Keep whole channels while they fit the budget; the rest become stale. Preserves channel order. */
export function budgetCatchup(
  messages: Message[],
  stale: string[],
  budget = CATCHUP_FRAME_BUDGET,
): { messages: Message[]; stale: string[] } {
  const byChannel = new Map<string, { msgs: Message[]; bytes: number }>();
  for (const m of messages) {
    const g = byChannel.get(m.channelId) ?? { msgs: [], bytes: 0 };
    g.msgs.push(m);
    g.bytes += utf8.encode(JSON.stringify(m)).byteLength + 1; // +1 for the array comma
    byChannel.set(m.channelId, g);
  }
  const kept: Message[] = [];
  const overflow: string[] = [];
  let used = 0;
  for (const [channelId, g] of byChannel) {
    if (used + g.bytes <= budget) {
      kept.push(...g.msgs);
      used += g.bytes;
    } else {
      overflow.push(channelId);
    }
  }
  return { messages: kept, stale: [...stale, ...overflow] };
}
/** Never schedule an alarm in the real past: workerd would fire it at once and could spin (P2-R6). */
const MIN_ALARM_DELAY_MS = 1_000;

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

/**
 * One per workspace (`env.HUB.getByName(workspaceId)`). Holds hibernatable sockets; all per-socket
 * state lives in the serialized attachment. Keeps no data in DO storage, only its alarm.
 */
export class WorkspaceHub extends DurableObject<Env> {
  /** Clock for presence; tests override it through `runInDurableObject`. */
  now: () => number = () => Date.now();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Answered by the runtime without waking the hub (free-tier budget, §13).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_FRAME, PONG_FRAME));
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return errorResponse(426, 'upgrade_required', 'WebSocket upgrade required.');
    }
    const userId = req.headers.get('X-Backroom-User');
    const workspaceId = req.headers.get('X-Backroom-Workspace');
    if (!userId || !workspaceId) return errorResponse(400, 'invalid_request', 'Invalid request');

    const { results } = await this.env.DB.prepare(
      `SELECT c.id AS id FROM channel_members cm JOIN channels c ON c.id = cm.channel_id
       WHERE cm.user_id = ? AND c.workspace_id = ? AND c.archived_at IS NULL`,
    )
      .bind(userId, workspaceId)
      .all<{ id: string }>();

    const announced: PresenceState = this.isActive(userId) ? 'active' : 'away';
    // A new tab of a user who is already active inherits their latest activity, so the alarm keeps
    // treating them consistently.
    const lastActivityAt = Math.max(0, ...this.socketsForUser(userId).map((ws) => getAtt(ws).lastActivityAt));
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [userId]);
    setAtt(server, { userId, workspaceId, channelIds: results.map((r) => r.id), lastActivityAt, announced });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string' || raw.length > MAX_FRAME_CHARS) {
      ws.close(1009, 'too large');
      return;
    }
    const parsed = parseClientFrame(raw);
    if (!parsed.ok) {
      if (parsed.clientId !== undefined) this.sendFrame(ws, { t: 'nack', clientId: parsed.clientId, code: parsed.code });
      return;
    }
    await this.dispatch(ws, parsed.frame);
  }

  private async dispatch(ws: WebSocket, f: ClientFrame): Promise<void> {
    switch (f.t) {
      case 'hello':
        return this.onHello(ws, f.lastSeen);
      case 'activity':
        return this.onActivity(ws);
      case 'ping':
        // Normally answered by the auto-response; this covers any non-identical ping text.
        return this.sendFrame(ws, { t: 'pong' });
      default:
        // send/edit/delete/mark_read/mark_thread_read/typing: added by later tasks.
        return;
    }
  }

  private async onHello(ws: WebSocket, lastSeen: Record<string, number>): Promise<void> {
    const channelIds = channelsOf(ws);
    let result: { messages: Message[]; stale: string[] };
    try {
      const r = await catchUp(this.env.DB, channelIds, lastSeen);
      result = budgetCatchup(r.messages, r.stale);
    } catch {
      // Never leave the client waiting: every requested channel becomes stale and is refetched over REST.
      console.error(JSON.stringify({ level: 'error', code: 'catchup_failed' }));
      const mine = new Set(channelIds);
      result = { messages: [], stale: Object.keys(lastSeen).filter((id) => mine.has(id)) };
    }
    const { messages, stale } = result;
    this.sendFrame(ws, { t: 'catchup', messages, presence: this.presenceSnapshot() });
    for (const channelId of stale) this.sendFrame(ws, { t: 'stale', channelId });
    await this.onActivity(ws);
  }

  private async onActivity(ws: WebSocket): Promise<void> {
    const att = getAtt(ws);
    const lastActivityAt = this.now();
    setAtt(ws, { ...att, lastActivityAt });
    if (!this.isActive(att.userId)) {
      this.setAnnounced(att.userId, 'active');
      this.broadcast({ t: 'presence', userId: att.userId, state: 'active' });
    }
    const expiry = lastActivityAt + ACTIVE_WINDOW_MS;
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || expiry < existing) await this.scheduleAlarm(expiry);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // already closed, or a reserved code (1005/1006) that cannot be echoed
    }
    this.onSocketGone(ws);
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    this.onSocketGone(ws);
  }

  private onSocketGone(ws: WebSocket): void {
    const att = getAtt(ws);
    if (!att) return;
    const others = this.socketsForUser(att.userId).filter((s) => s !== ws);
    if (others.length === 0 && att.announced === 'active') {
      this.broadcast({ t: 'presence', userId: att.userId, state: 'away' });
    }
  }

  async alarm(): Promise<void> {
    const now = this.now();
    const expiryOf = new Map<string, number>();
    for (const ws of this.openSockets()) {
      const a = getAtt(ws);
      if (a.announced !== 'active') continue;
      expiryOf.set(a.userId, Math.max(expiryOf.get(a.userId) ?? 0, a.lastActivityAt + ACTIVE_WINDOW_MS));
    }
    let earliest: number | null = null;
    for (const [userId, expiry] of expiryOf) {
      if (expiry <= now) {
        this.setAnnounced(userId, 'away');
        this.broadcast({ t: 'presence', userId, state: 'away' });
      } else if (earliest === null || expiry < earliest) {
        earliest = expiry;
      }
    }
    if (earliest !== null) await this.scheduleAlarm(earliest);
  }

  private async scheduleAlarm(at: number): Promise<void> {
    await this.ctx.storage.setAlarm(Math.max(at, Date.now() + MIN_ALARM_DELAY_MS));
  }

  private presenceSnapshot(): { userId: string; state: PresenceState }[] {
    const users = new Set(this.openSockets().map((ws) => getAtt(ws).userId));
    return [...users].map((userId) => ({ userId, state: this.isActive(userId) ? 'active' : 'away' }));
  }

  private setAnnounced(userId: string, announced: PresenceState): void {
    for (const ws of this.socketsForUser(userId)) {
      const a = getAtt(ws);
      if (a.announced !== announced) setAtt(ws, { ...a, announced });
    }
  }

  private broadcast(f: HubFrame): void {
    for (const ws of this.openSockets()) this.sendFrame(ws, f);
  }

  /** Accepted sockets that are still open (a socket being closed may still be listed). */
  private openSockets(tag?: string): WebSocket[] {
    return this.ctx.getWebSockets(tag).filter((ws) => ws.readyState === WebSocket.OPEN);
  }

  private socketsForChannel(channelId: string): WebSocket[] {
    return this.openSockets().filter((ws) => channelsOf(ws).includes(channelId));
  }

  private socketsForUser(userId: string): WebSocket[] {
    return this.openSockets(userId);
  }

  private sendFrame(ws: WebSocket, f: HubFrame): void {
    try {
      ws.send(JSON.stringify(f));
    } catch {
      // A closing socket is expected to reject sends (its close handler cleans up); anything else is a bug.
      if (ws.readyState === WebSocket.OPEN) {
        console.error(JSON.stringify({ level: 'error', code: 'ws_send_failed', t: f.t }));
      }
    }
  }

  /** The user's announced presence (what other members currently see). */
  private isActive(userId: string): boolean {
    return this.socketsForUser(userId).some((ws) => getAtt(ws).announced === 'active');
  }
}
