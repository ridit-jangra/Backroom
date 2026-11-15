import { DurableObject } from 'cloudflare:workers';
import {
  ACTIVE_WINDOW_MS,
  PING_FRAME,
  PONG_FRAME,
  parseClientFrame,
  type ChannelInfo,
  type ChannelSummary,
  type ClientFrame,
  type CustomEmoji,
  type HubFrame,
  type Message,
  type NackCode,
  type PresenceState,
  MARK_READ_INTERVAL_MS,
} from '@backroom/protocol';
import type { Env } from '../env';
import { catchUp } from '../messaging/read';
import { notifyTargets } from '../messaging/notify';
import { MESSAGE_COLUMNS, rowToMessage } from '../messaging/rows';
import { deleteMessage, editMessage, sendMessage, type Audience, type DeleteResult } from '../messaging/store';
import { toggleReaction } from '../emoji/reactions';
import { withFiles } from '../files/attach';
import { addChannel, channelsOf, getAtt, removeChannel, setAtt } from './attachment';
import { frameCost, takeFrameBudget } from './budget';
import { autoResponsePair, newWebSocketPair, upgradeResponse } from './platform';

export type MembershipChange =
  | {
      action: 'added';
      userIds: string[];
      channel: ChannelSummary;
      /** Per-recipient summaries (their own read position and counts); `channel` is the fallback. */
      perUser?: Record<string, ChannelSummary>;
    }
  | { action: 'removed'; userIds: string[]; channelId: string };

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
/** How long the in-memory clientId map remembers a send; D1's unique index is the backstop after that. */
const RECENT_TTL_MS = 300_000;
const RECENT_MAX = 1_000;

/** What a queued send resolved to; deliberately tiny so `recent` never holds a message body. */
type SendOutcome = { messageId: string } | { code: NackCode };

type ReadState = { lastWriteAt: number; lastSeq: number; pending?: number; timer?: number };

type SendFrame = Extract<ClientFrame, { t: 'send' }>;
/**
 * Frames for a delete: the tombstone, one more per reply a starter's deletion swept (so open tabs drop them and
 * `seq` stays continuous; capped at MAX_CASCADE_FRAMES, clients also drop a deleted starter's replies), and for a
 * deleted reply the starter's recomputed counters.
 */
function deleteFrames(d: DeleteResult): HubFrame[] {
  const frames: HubFrame[] = [{ t: 'message.delete', message: d.message }];
  for (const m of d.replies) frames.push({ t: 'message.delete', message: m });
  if (d.parent) {
    frames.push({
      t: 'thread.counts',
      channelId: d.parent.channelId,
      parentId: d.parent.id,
      replyCount: d.parent.replyCount,
      lastReplyAt: d.parent.lastReplyAt,
    });
  }
  return frames;
}

type EditFrame = Extract<ClientFrame, { t: 'edit' }>;
type DeleteFrame = Extract<ClientFrame, { t: 'delete' }>;
type ReactFrame = Extract<ClientFrame, { t: 'react' }>;

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

  /** Per-channel tail of the write chain, so D1 writes and their broadcasts leave in `seq` order. */
  private queues = new Map<string, Promise<unknown>>();
  /** Recent sends keyed `${userId}:${clientId}` (insertion order = age); a nack deletes its entry. */
  private recent = new Map<string, { at: number; result: Promise<SendOutcome> }>();
  /** Sockets whose channel set is still being read on connect, with the membership changes seen meanwhile. */
  private connecting = new Map<WebSocket, MembershipChange[]>();
  /** Test seam: runs on connect after accept, before the channel-set read. */
  beforeChannelRead?: () => Promise<void>;
  /** Per-socket mark_read / mark_thread_read throttle state, keyed by channel or `thread:<id>`. */
  private readState = new WeakMap<WebSocket, Map<string, ReadState>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Answered by the runtime without waking the hub (free-tier budget, §13).
    ctx.setWebSocketAutoResponse(autoResponsePair(PING_FRAME, PONG_FRAME));
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return errorResponse(426, 'upgrade_required', 'WebSocket upgrade required.');
    }
    const userId = req.headers.get('X-Backroom-User');
    const workspaceId = req.headers.get('X-Backroom-Workspace');
    if (!userId || !workspaceId) return errorResponse(400, 'invalid_request', 'Invalid request');

    const announced: PresenceState = this.isActive(userId) ? 'active' : 'away';
    // A new tab of a user who is already active inherits their latest activity, so the alarm keeps
    // treating them consistently.
    const lastActivityAt = Math.max(0, ...this.socketsForUser(userId).map((ws) => getAtt(ws).lastActivityAt));
    const pair = newWebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    // Accept before reading the channel set, and log membership changes that arrive during the read:
    // the read may predate a change whose RPC lands meanwhile, so the log is replayed on top of it.
    this.ctx.acceptWebSocket(server, [userId]);
    setAtt(server, { userId, workspaceId, channelIds: [], lastActivityAt, announced });
    const log: MembershipChange[] = [];
    this.connecting.set(server, log);
    try {
      await this.beforeChannelRead?.();
      // Read membership and channels together: a deactivation that committed after the route's
      // check (and whose disconnectUser ran before this socket was accepted) is caught here.
      const [active, channels] = await this.env.DB.batch([
        this.env.DB.prepare(
          'SELECT 1 AS ok FROM workspace_members WHERE user_id = ? AND workspace_id = ? AND deactivated_at IS NULL',
        ).bind(userId, workspaceId),
        this.env.DB.prepare(
          `SELECT c.id AS id FROM channel_members cm
           JOIN channels c ON c.id = cm.channel_id
           JOIN workspace_members wm ON wm.user_id = cm.user_id AND wm.workspace_id = c.workspace_id
             AND wm.deactivated_at IS NULL
           WHERE cm.user_id = ? AND c.workspace_id = ? AND c.archived_at IS NULL`,
        ).bind(userId, workspaceId),
      ]);
      if (active!.results.length === 0) {
        server.close(4001, 'deactivated');
        return upgradeResponse(client);
      }
      const ids = new Set((channels!.results as { id: string }[]).map((r) => r.id));
      for (const change of log) {
        if (change.action === 'added') ids.add(change.channel.id);
        else ids.delete(change.channelId);
      }
      setAtt(server, { ...getAtt(server), channelIds: [...ids] });
    } catch (e) {
      try {
        server.close(1011, 'connect failed');
      } catch {
        // already closed
      }
      throw e;
    } finally {
      this.connecting.delete(server);
    }
    return upgradeResponse(client);
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
    if (!this.withinBudget(ws, parsed.frame)) return;
    await this.dispatch(ws, parsed.frame);
  }

  /**
   * Phase 6 per-socket token bucket (budget.ts), checked before any work, so an over-budget frame never
   * reaches D1 or a channel queue and cannot delay other sockets. Over budget: a frame with a clientId
   * is nacked `rate_limited`, one without is dropped. State lives in the attachment (hibernation-safe).
   */
  private withinBudget(ws: WebSocket, f: ClientFrame): boolean {
    // Checked before the `recent` lookup, so a resend of an in-flight or recent clientId also costs a token.
    const cost = frameCost(f);
    if (cost === null) return true;
    const att = getAtt(ws);
    const r = takeFrameBudget(att.budget, cost, this.now());
    setAtt(ws, { ...att, budget: r.budget });
    if (r.ok) return true;
    const clientId = 'clientId' in f ? f.clientId : undefined;
    if (clientId !== undefined) this.sendFrame(ws, { t: 'nack', clientId, code: 'rate_limited' });
    return false;
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
      case 'send':
        return this.onSend(ws, f);
      case 'edit':
        return this.onEditOrDelete(ws, f);
      case 'delete':
        return this.onEditOrDelete(ws, f);
      case 'react':
        return this.onReact(ws, f);
      case 'mark_read':
        return this.onMarkRead(ws, f.channelId, f.seq);
      case 'mark_thread_read':
        return this.onMarkThreadRead(ws, f.messageId, f.seq);
      case 'typing':
        return this.onTyping(ws, f.channelId, f.parentId);
      default:
        return;
    }
  }

  private enqueue<T>(channelId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(channelId) ?? Promise.resolve();
    const run = prev.then(fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(channelId, tail);
    void tail.then(() => {
      if (this.queues.get(channelId) === tail) this.queues.delete(channelId);
    });
    return run;
  }

  private pruneRecent(now: number): void {
    for (const [key, entry] of this.recent) {
      if (now - entry.at < RECENT_TTL_MS && this.recent.size <= RECENT_MAX) break;
      this.recent.delete(key);
    }
  }

  private async onSend(ws: WebSocket, f: SendFrame): Promise<void> {
    const att = getAtt(ws);
    const key = `${att.userId}:${f.clientId}`;
    const now = this.now();
    this.pruneRecent(now);
    const hit = this.recent.get(key);
    if (hit) {
      // In-flight or recently answered: replay the original answer only (no second broadcast).
      this.sendFrame(ws, await this.frameFor(f.clientId, await hit.result));
      return;
    }
    if (!channelsOf(ws).includes(f.channelId)) {
      this.sendFrame(ws, { t: 'nack', clientId: f.clientId, code: 'not_found' });
      return;
    }
    let stored: Message | undefined;
    let fresh = false;
    const result = this.enqueue(f.channelId, async (): Promise<SendOutcome> => {
      let r: Awaited<ReturnType<typeof sendMessage>>;
      try {
        r = await sendMessage(this.env.DB, {
          clientId: f.clientId,
          channelId: f.channelId,
          userId: att.userId,
          parentId: f.parentId ?? null,
          body: f.body,
          alsoInChannel: f.alsoInChannel ?? false,
          fileIds: f.fileIds ?? [],
          // Stamped when the queued write runs, so created_at (and the ULID) follow seq order.
          now: this.now(),
        });
      } catch {
        console.error(JSON.stringify({ level: 'error', code: 'send_failed' }));
        return { code: 'failed' };
      }
      if (!r.ok) return { code: r.code };
      stored = r.message;
      if (!r.duplicate) {
        fresh = true;
        // The message is stored: nothing after this point may turn the send into a failure.
        try {
          const frame: HubFrame = { t: 'message.new', message: { ...r.message, reactions: [] } };
          for (const s of this.socketsForChannel(f.channelId)) if (s !== ws) this.sendFrame(s, frame);
        } catch {
          console.error(JSON.stringify({ level: 'error', code: 'broadcast_failed' }));
        }
        try {
          this.notify(r.message, r.audience);
        } catch {
          console.error(JSON.stringify({ level: 'error', code: 'notify_failed' }));
        }
      }
      return { messageId: r.message.id };
    }).catch((): SendOutcome => ({ code: 'failed' }));
    this.recent.set(key, { at: now, result });
    if (this.recent.size > RECENT_MAX) this.pruneRecent(now);
    const outcome = await result;
    if ('code' in outcome && this.recent.get(key)?.result === result) this.recent.delete(key);
    this.sendFrame(ws, stored && 'messageId' in outcome ? { t: 'ack', clientId: f.clientId, message: fresh ? { ...stored, reactions: [] } : stored } : await this.frameFor(f.clientId, outcome));
  }

  /** Builds the ack for a stored send by reloading it from D1 (`recent` keeps ids only), or the nack. */
  private async frameFor(clientId: string, outcome: SendOutcome): Promise<HubFrame> {
    if ('code' in outcome) return { t: 'nack', clientId, code: outcome.code };
    try {
      const row = await this.env.DB.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`)
        .bind(outcome.messageId)
        .first<Record<string, unknown>>();
      if (row) return { t: 'ack', clientId, message: (await withFiles(this.env.DB, [rowToMessage(row)]))[0]! };
    } catch {
      console.error(JSON.stringify({ level: 'error', code: 'ack_reload_failed' }));
    }
    return { t: 'nack', clientId, code: 'failed' };
  }

  /** Notification fan-out for a freshly stored message (Task 6). */
  private notify(message: Message, audience: Audience): void {
    // A file-only message previews its file names instead of an empty body.
    const text = message.body.trim() !== '' ? message.body : (message.files ?? []).map((f) => f.name).join(', ');
    const preview = Array.from(text).slice(0, 140).join('');
    for (const { userId, kind } of notifyTargets(audience, message, (u) => this.isActive(u))) {
      const frame: HubFrame = {
        t: 'notify',
        kind,
        channelId: message.channelId,
        messageId: message.id,
        parentId: message.parentId,
        fromUserId: message.userId,
        preview,
      };
      for (const s of this.socketsForUser(userId)) this.sendFrame(s, frame);
    }
  }

  /**
   * At most one D1 write per key per MARK_READ_INTERVAL_MS per socket; writes inside the window keep
   * the highest seq and flush when it ends. `write` returns the position now stored, if known.
   */
  private throttleRead(ws: WebSocket, key: string, seq: number, write: (seq: number) => Promise<number | undefined>): void {
    let states = this.readState.get(ws);
    if (!states) this.readState.set(ws, (states = new Map()));
    let st = states.get(key);
    if (!st) states.set(key, (st = { lastWriteAt: Number.NEGATIVE_INFINITY, lastSeq: 0 }));
    const state = st;
    if (seq <= Math.max(state.lastSeq, state.pending ?? 0)) return;
    const run = (value: number): void => {
      const prev = state.lastSeq;
      state.lastWriteAt = this.now();
      state.lastSeq = value; // optimistic, so a burst is coalesced before the write returns
      write(value).then(
        (stored) => {
          if (stored !== undefined && state.lastSeq === value) state.lastSeq = stored;
        },
        () => {
          if (state.lastSeq === value) state.lastSeq = prev;
          console.error(JSON.stringify({ level: 'error', code: 'mark_read_failed' }));
        },
      );
    };
    const wait = state.lastWriteAt + MARK_READ_INTERVAL_MS - this.now();
    if (wait <= 0) {
      run(seq);
      return;
    }
    state.pending = seq;
    if (state.timer === undefined) {
      state.timer = setTimeout(() => {
        state.timer = undefined;
        const p = state.pending;
        state.pending = undefined;
        if (p !== undefined) run(p);
      }, wait) as unknown as number;
    }
  }

  private onMarkRead(ws: WebSocket, channelId: string, seq: number): void {
    if (!channelsOf(ws).includes(channelId)) return;
    const { userId } = getAtt(ws);
    this.throttleRead(ws, channelId, seq, async (value) => {
      const row = await this.env.DB.prepare(
        `UPDATE channel_members SET last_read_seq = MIN(?1, (SELECT last_seq FROM channels WHERE id = ?2))
         WHERE channel_id = ?2 AND user_id = ?3 AND last_read_seq < ?1
           AND last_read_seq < (SELECT last_seq FROM channels WHERE id = ?2) RETURNING last_read_seq AS seq`,
      )
        .bind(value, channelId, userId)
        .first<{ seq: number }>();
      if (!row) {
        // Nothing moved (already read that far): learn the stored position so a later seq is not ignored.
        const cur = await this.env.DB.prepare('SELECT last_read_seq AS seq FROM channel_members WHERE channel_id = ? AND user_id = ?')
          .bind(channelId, userId)
          .first<{ seq: number }>();
        return cur?.seq;
      }
      // Clamped to last_seq by the UPDATE (P2-R16); only sent when the row changed.
      for (const s of this.socketsForUser(userId)) {
        if (s !== ws) this.sendFrame(s, { t: 'read', channelId, seq: row.seq });
      }
      return row.seq;
    });
  }

  private onMarkThreadRead(ws: WebSocket, messageId: string, seq: number): void {
    const { userId } = getAtt(ws);
    this.throttleRead(ws, `thread:${messageId}`, seq, async (value) => {
      await this.env.DB.prepare(
        'UPDATE thread_follows SET last_read_reply_seq = ? WHERE message_id = ? AND user_id = ? AND last_read_reply_seq < ?',
      )
        .bind(value, messageId, userId, value)
        .run();
      return value;
    });
  }

  private onTyping(ws: WebSocket, channelId: string, parentId: string | undefined): void {
    if (!channelsOf(ws).includes(channelId)) return;
    const { userId } = getAtt(ws);
    const frame: HubFrame = parentId === undefined
      ? { t: 'typing', channelId, userId }
      : { t: 'typing', channelId, userId, parentId };
    for (const s of this.socketsForChannel(channelId)) if (getAtt(s).userId !== userId) this.sendFrame(s, frame);
  }

  private async onEditOrDelete(ws: WebSocket, f: EditFrame | DeleteFrame): Promise<void> {
    const { userId } = getAtt(ws);
    const nack = (code: NackCode) => {
      if (f.clientId !== undefined) this.sendFrame(ws, { t: 'nack', clientId: f.clientId, code });
    };
    let row: { channelId: string } | null;
    try {
      row = await this.env.DB.prepare('SELECT channel_id AS channelId FROM messages WHERE id = ?')
        .bind(f.messageId)
        .first<{ channelId: string }>();
    } catch {
      return nack('failed');
    }
    if (!row) return nack('not_found');
    const channelId = row.channelId;
    await this.enqueue(channelId, async () => {
      let frames: HubFrame[];
      let failure: NackCode | null = null;
      try {
        if (f.t === 'edit') {
          const r = await editMessage(this.env.DB, { messageId: f.messageId, userId, body: f.body, now: this.now() });
          if (r.ok) frames = [{ t: 'message.edit', message: r.message }];
          else {
            frames = [];
            failure = r.code;
          }
        } else {
          const r = await deleteMessage(this.env.DB, { messageId: f.messageId, userId, now: this.now() });
          if (r.ok) frames = deleteFrames(r);
          else {
            frames = [];
            failure = r.code;
          }
        }
      } catch {
        console.error(JSON.stringify({ level: 'error', code: `${f.t}_failed` }));
        return nack('failed');
      }
      if (failure !== null) return nack(failure);
      const targets = this.socketsForChannel(channelId);
      // A public channel's author may edit after leaving it; they still see their own change.
      if (!targets.includes(ws)) targets.push(ws);
      for (const frame of frames) for (const s of targets) this.sendFrame(s, frame);
    });
  }

  private async onReact(ws: WebSocket, f: ReactFrame): Promise<void> {
    const { userId } = getAtt(ws);
    const nack = (code: NackCode) => {
      if (f.clientId !== undefined) this.sendFrame(ws, { t: 'nack', clientId: f.clientId, code });
    };
    let row: { channelId: string } | null;
    try {
      row = await this.env.DB.prepare('SELECT channel_id AS channelId FROM messages WHERE id = ?')
        .bind(f.messageId)
        .first<{ channelId: string }>();
    } catch {
      console.error(JSON.stringify({ level: 'error', code: 'react_failed' }));
      return nack('failed');
    }
    if (!row || !channelsOf(ws).includes(row.channelId)) return nack('not_found');
    const channelId = row.channelId;
    await this.enqueue(channelId, async () => {
      let r: Awaited<ReturnType<typeof toggleReaction>>;
      try {
        r = await toggleReaction(this.env.DB, {
          messageId: f.messageId,
          userId,
          emoji: f.emoji,
          on: f.on,
          now: this.now(),
        });
      } catch {
        console.error(JSON.stringify({ level: 'error', code: 'react_failed' }));
        return nack('failed');
      }
      if (!r.ok) return nack(r.code);
      const frame: HubFrame = {
        t: 'reaction',
        channelId,
        messageId: f.messageId,
        emoji: r.emoji,
        userId,
        on: f.on,
      };
      // Unchanged: only the sender hears it, so a stale tab converges without noising the channel.
      const targets = r.changed ? this.socketsForChannel(channelId) : [ws];
      for (const s of targets) this.sendFrame(s, frame);
    });
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

  /* RPC from REST routes (Task 7). D1 is already updated when these run. */

  /** Updates each listed user's socket channel sets and tells those sockets. */
  async membershipChanged(change: MembershipChange): Promise<void> {
    for (const userId of new Set(change.userIds)) {
      for (const ws of this.socketsForUser(userId)) {
        this.connecting.get(ws)?.push(change);
        if (change.action === 'added') {
          addChannel(ws, change.channel.id);
          this.sendFrame(ws, { t: 'membership', action: 'added', channel: change.perUser?.[userId] ?? change.channel });
        } else {
          removeChannel(ws, change.channelId);
          this.sendFrame(ws, { t: 'membership', action: 'removed', channelId: change.channelId });
        }
      }
    }
  }

  async channelUpdated(channel: ChannelInfo): Promise<void> {
    const frame: HubFrame = { t: 'channel.update', channel };
    for (const ws of this.socketsForChannel(channel.id)) this.sendFrame(ws, frame);
  }

  /** Custom emoji added or removed (D1 already updated): every open socket in the workspace hears it. */
  async emojiChanged(change: { added: CustomEmoji[]; removed: string[] }): Promise<void> {
    this.broadcast({ t: 'emoji.update', added: change.added, removed: change.removed });
  }

  /** Closes every socket of a deactivated user (4001: the client signs out and does not reconnect). */
  async disconnectUser(userId: string): Promise<void> {
    const sockets = this.socketsForUser(userId);
    if (sockets.length === 0) return;
    const wasActive = this.isActive(userId);
    // Mark them away first so the close handler does not announce a second `away`.
    this.setAnnounced(userId, 'away');
    for (const ws of sockets) {
      try {
        ws.close(4001, 'deactivated');
      } catch {
        // already closing
      }
    }
    if (wasActive) this.broadcast({ t: 'presence', userId, state: 'away' });
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
