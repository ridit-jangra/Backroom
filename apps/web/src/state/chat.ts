import {
  TYPING_TTL_MS,
  extractMentions,
  type Bootstrap,
  type ChannelSummary,
  type HistoryPage,
  type HubFrame,
  type Message,
  type PresenceState,
  type ThreadPage,
} from '@backroom/protocol';
import type { PendingSend } from '../realtime/outbox';
import type { SocketState } from '../realtime/socket';

export type ChannelWindow = { messages: Message[]; hasOlder: boolean; loaded: boolean };

export type TypingEntry = { channelId: string; parentId: string | null; userId: string; until: number };

export type ChatState = {
  me: string;
  bootstrap: Bootstrap | null;
  channels: Record<string, ChannelSummary>;
  windows: Record<string, ChannelWindow>;
  threads: Record<string, ThreadPage>;
  /** Channels archived while this tab was open: kept read-only so the open view does not vanish. */
  archived: Record<string, { name: string | null; topic: string | null; window: ChannelWindow | undefined }>;
  pending: PendingSend[];
  presence: Record<string, PresenceState>;
  typing: TypingEntry[];
  lastSeen: Record<string, number>;
  connection: SocketState;
  openChannelId: string | null;
  openThreadId: string | null;
  focused: boolean;
};

export type ChatEvent =
  | HubFrame
  | { t: 'local.bootstrap'; bootstrap: Bootstrap }
  | { t: 'local.history'; channelId: string; page: HistoryPage; mode: 'replace' | 'prepend' }
  | { t: 'local.thread'; page: ThreadPage }
  | { t: 'local.open'; channelId: string }
  | { t: 'local.openThread'; parentId: string | null }
  | { t: 'local.focus'; focused: boolean }
  | { t: 'local.pending'; pending: PendingSend[] }
  | { t: 'local.connection'; state: SocketState }
  | { t: 'local.tick'; now: number };

export function initialChat(me: string): ChatState {
  return {
    me,
    bootstrap: null,
    channels: {},
    windows: {},
    threads: {},
    archived: {},
    pending: [],
    presence: {},
    typing: [],
    lastSeen: {},
    connection: 'connecting',
    openChannelId: null,
    openThreadId: null,
    focused: true,
  };
}

export function isViewing(s: ChatState, channelId: string): boolean {
  return s.focused && s.openChannelId === channelId;
}

export function lastSeenFor(s: ChatState): Record<string, number> {
  const out: Record<string, number> = { ...s.lastSeen };
  for (const c of Object.values(s.channels)) out[c.id] = Math.max(out[c.id] ?? 0, c.lastSeq);
  return out;
}

/** Pick between a held message and an incoming copy; a replay never reverts newer edits or deletes. */
function pick(held: Message | undefined, incoming: Message): Message {
  if (!held) return incoming;
  if (held.deletedAt !== null && incoming.deletedAt === null) return held;
  if (held.deletedAt === null && incoming.deletedAt !== null) return incoming;
  return (held.editedAt ?? 0) > (incoming.editedAt ?? 0) ? held : incoming;
}

function mergeMessages(existing: Message[], incoming: Message[]): Message[] {
  const byId = new Map<string, Message>();
  for (const m of existing) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, pick(byId.get(m.id), m));
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

function zeroCounts(c: ChannelSummary): ChannelSummary {
  return c.unreadCount === 0 && c.mentionCount === 0 ? c : { ...c, unreadCount: 0, mentionCount: 0 };
}

function dropChannel(s: ChatState, channelId: string): ChatState {
  const channels = { ...s.channels };
  delete channels[channelId];
  const windows = { ...s.windows };
  delete windows[channelId];
  const threads: Record<string, ThreadPage> = {};
  for (const [id, t] of Object.entries(s.threads)) if (t.parent.channelId !== channelId) threads[id] = t;
  const threadOpenHere =
    s.openThreadId !== null &&
    (s.threads[s.openThreadId]?.parent.channelId === channelId || s.openChannelId === channelId);
  const lastSeen = { ...s.lastSeen };
  delete lastSeen[channelId];
  return {
    ...s,
    channels,
    windows,
    threads,
    lastSeen,
    typing: s.typing.filter((x) => x.channelId !== channelId),
    openChannelId: s.openChannelId === channelId ? null : s.openChannelId,
    openThreadId: threadOpenHere ? null : s.openThreadId,
  };
}

/** Replace a message by id wherever it is held (windows, thread parents and replies). */
function replaceEverywhere(s: ChatState, m: Message): ChatState {
  let windows = s.windows;
  const w = s.windows[m.channelId];
  if (w?.messages.some((x) => x.id === m.id)) {
    windows = { ...windows, [m.channelId]: { ...w, messages: w.messages.map((x) => (x.id === m.id ? pick(x, m) : x)) } };
  }
  let threads = s.threads;
  for (const [pid, t] of Object.entries(s.threads)) {
    const inReplies = t.replies.some((x) => x.id === m.id);
    if (t.parent.id === m.id || inReplies) {
      threads = {
        ...threads,
        [pid]: {
          parent: t.parent.id === m.id ? pick(t.parent, m) : t.parent,
          replies: inReplies ? t.replies.map((x) => (x.id === m.id ? pick(x, m) : x)) : t.replies,
        },
      };
    }
  }
  return windows === s.windows && threads === s.threads ? s : { ...s, windows, threads };
}

function applyMessage(s: ChatState, m: Message): ChatState {
  const ch = s.channels[m.channelId];
  const prev = Math.max(s.lastSeen[m.channelId] ?? 0, ch?.lastSeq ?? 0);
  const inChannelView = m.parentId === null || m.alsoInChannel;
  const known =
    (inChannelView && (s.windows[m.channelId]?.messages.some((x) => x.id === m.id) ?? false)) ||
    (m.parentId !== null && (s.threads[m.parentId]?.replies.some((x) => x.id === m.id) ?? false));
  const isNew = m.seq > prev && !known;
  let next: ChatState = { ...s, lastSeen: { ...s.lastSeen, [m.channelId]: Math.max(s.lastSeen[m.channelId] ?? 0, m.seq) } };

  let channel = ch;
  if (channel) {
    channel = { ...channel, lastSeq: Math.max(channel.lastSeq, m.seq) };
    if (isNew && inChannelView && m.userId !== s.me && m.deletedAt === null && !isViewing(s, m.channelId)) {
      const mn = extractMentions(m.body);
      const mentioned = mn.userIds.includes(s.me) || mn.channel || mn.here;
      channel = {
        ...channel,
        unreadCount: channel.unreadCount + 1,
        mentionCount: channel.mentionCount + (mentioned ? 1 : 0),
      };
    }
    next.channels = { ...next.channels, [m.channelId]: channel };
  }

  if (inChannelView) {
    const w = next.windows[m.channelId];
    if (w?.loaded) {
      next.windows = { ...next.windows, [m.channelId]: { ...w, messages: mergeMessages(w.messages, [m]) } };
    }
  }

  if (m.parentId !== null) {
    const pid = m.parentId;
    const t = next.threads[pid];
    if (t) {
      next.threads = { ...next.threads, [pid]: { ...t, replies: mergeMessages(t.replies, [m]) } };
    }
    if (isNew) next = bumpParent(next, m);
  }
  return next;
}

function bumpParent(s: ChatState, reply: Message): ChatState {
  const pid = reply.parentId!;
  const bump = (p: Message): Message => ({
    ...p,
    replyCount: p.replyCount + 1,
    lastReplyAt: Math.max(p.lastReplyAt ?? 0, reply.createdAt),
  });
  let next = s;
  const w = s.windows[reply.channelId];
  if (w?.messages.some((x) => x.id === pid)) {
    next = {
      ...next,
      windows: { ...next.windows, [reply.channelId]: { ...w, messages: w.messages.map((x) => (x.id === pid ? bump(x) : x)) } },
    };
  }
  const t = next.threads[pid];
  if (t) next = { ...next, threads: { ...next.threads, [pid]: { ...t, parent: bump(t.parent) } } };
  return next;
}

export function reduce(state: ChatState, e: ChatEvent, now: number): ChatState {
  switch (e.t) {
    case 'ack':
      return {
        ...applyMessage(state, e.message),
        pending: state.pending.filter((p) => p.clientId !== e.clientId),
      };
    case 'message.new':
      return applyMessage(state, e.message);
    case 'message.edit':
    case 'message.delete':
      return replaceEverywhere(state, e.message);
    case 'catchup': {
      let s = state;
      for (const m of [...e.messages].sort((a, b) => a.seq - b.seq)) s = applyMessage(s, m);
      if (e.presence.length > 0) {
        const presence = { ...s.presence };
        for (const p of e.presence) presence[p.userId] = p.state;
        s = { ...s, presence };
      }
      return s;
    }
    case 'read': {
      const c = state.channels[e.channelId];
      if (!c) return state;
      let next: ChannelSummary = { ...c, lastReadSeq: Math.max(c.lastReadSeq, e.seq) };
      if (e.seq >= c.lastSeq) next = zeroCounts(next);
      return { ...state, channels: { ...state.channels, [e.channelId]: next } };
    }
    case 'channel.update': {
      const c = state.channels[e.channel.id];
      if (e.channel.archivedAt !== null) {
        const dropped = dropChannel(state, e.channel.id);
        return {
          ...dropped,
          archived: {
            ...dropped.archived,
            [e.channel.id]: { name: e.channel.name, topic: e.channel.topic, window: state.windows[e.channel.id] },
          },
        };
      }
      if (state.archived[e.channel.id]) {
        const archived = { ...state.archived };
        delete archived[e.channel.id];
        state = { ...state, archived };
      }
      if (!c) return state;
      return {
        ...state,
        channels: { ...state.channels, [c.id]: { ...c, name: e.channel.name, topic: e.channel.topic } },
      };
    }
    case 'membership': {
      if (e.action === 'removed') return dropChannel(state, e.channelId);
      if (state.archived[e.channel.id]) {
        const archived = { ...state.archived };
        delete archived[e.channel.id];
        state = { ...state, archived };
      }
      const known = state.channels[e.channel.id];
      if (known) {
        // P2-R23: metadata merge only; keep local counts, lastReadSeq and lastSeq.
        const merged: ChannelSummary = {
          ...known,
          name: e.channel.name,
          topic: e.channel.topic,
          kind: e.channel.kind,
          createdBy: e.channel.createdBy,
          dmUserIds: e.channel.dmUserIds,
        };
        const same = (Object.keys(merged) as (keyof ChannelSummary)[]).every(
          (k) => JSON.stringify(merged[k]) === JSON.stringify(known[k]),
        );
        return same ? state : { ...state, channels: { ...state.channels, [known.id]: merged } };
      }
      return { ...state, channels: { ...state.channels, [e.channel.id]: e.channel } };
    }
    case 'presence':
      return { ...state, presence: { ...state.presence, [e.userId]: e.state } };
    case 'typing': {
      const parentId = e.parentId ?? null;
      const rest = state.typing.filter(
        (x) => !(x.channelId === e.channelId && x.parentId === parentId && x.userId === e.userId),
      );
      return { ...state, typing: [...rest, { channelId: e.channelId, parentId, userId: e.userId, until: now + TYPING_TTL_MS }] };
    }
    case 'stale': {
      const windows = { ...state.windows };
      delete windows[e.channelId];
      const threads: Record<string, ThreadPage> = {};
      for (const [id, t] of Object.entries(state.threads)) if (t.parent.channelId !== e.channelId) threads[id] = t;
      return { ...state, windows, threads, typing: state.typing.filter((x) => x.channelId !== e.channelId) };
    }
    case 'nack':
      return {
        ...state,
        pending: state.pending.map((p) =>
          p.clientId === e.clientId ? { ...p, status: 'failed' as const, error: e.code } : p,
        ),
      };
    case 'notify':
    case 'pong':
      return state;
    case 'local.bootstrap': {
      const channels: Record<string, ChannelSummary> = {};
      for (const c of e.bootstrap.channels) {
        const known = state.channels[c.id];
        const lastSeq = Math.max(c.lastSeq, state.lastSeen[c.id] ?? 0, known?.lastSeq ?? 0);
        const merged = { ...c, lastSeq };
        channels[c.id] = isViewing(state, c.id) ? zeroCounts(merged) : merged;
      }
      return { ...state, me: e.bootstrap.me.id, bootstrap: e.bootstrap, channels };
    }
    case 'local.history': {
      const old = state.windows[e.channelId];
      const maxSeq = e.page.messages.reduce((a, m) => Math.max(a, m.seq), 0);
      const messages =
        e.mode === 'replace' || !old
          ? mergeMessages(
              [],
              [...e.page.messages, ...(old && e.mode === 'replace' ? old.messages.filter((m) => m.seq > maxSeq) : [])],
            )
          : mergeMessages(old.messages, e.page.messages);
      return {
        ...state,
        windows: { ...state.windows, [e.channelId]: { messages, hasOlder: e.page.hasMore, loaded: true } },
      };
    }
    case 'local.thread': {
      const s = { ...state, threads: { ...state.threads, [e.page.parent.id]: e.page } };
      return replaceParentInWindow(s, e.page.parent);
    }
    case 'local.open': {
      const c = state.channels[e.channelId];
      return {
        ...state,
        openChannelId: e.channelId,
        channels: c ? { ...state.channels, [c.id]: zeroCounts(c) } : state.channels,
      };
    }
    case 'local.openThread':
      return { ...state, openThreadId: e.parentId };
    case 'local.focus': {
      const s = { ...state, focused: e.focused };
      const c = e.focused && s.openChannelId ? s.channels[s.openChannelId] : undefined;
      return c ? { ...s, channels: { ...s.channels, [c.id]: zeroCounts(c) } } : s;
    }
    case 'local.pending':
      return { ...state, pending: e.pending };
    case 'local.connection':
      return { ...state, connection: e.state };
    case 'local.tick': {
      const typing = state.typing.filter((x) => x.until > e.now);
      return typing.length === state.typing.length ? state : { ...state, typing };
    }
  }
}

function replaceParentInWindow(s: ChatState, parent: Message): ChatState {
  const w = s.windows[parent.channelId];
  if (!w?.messages.some((x) => x.id === parent.id)) return s;
  return {
    ...s,
    windows: { ...s.windows, [parent.channelId]: { ...w, messages: w.messages.map((x) => (x.id === parent.id ? parent : x)) } },
  };
}
