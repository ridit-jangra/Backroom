import {
  TYPING_TTL_MS,
  extractMentions,
  type Bootstrap,
  type ChannelSummary,
  type CustomEmoji,
  type FileInfo,
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
  /** Custom emoji by name. */
  customEmoji: Record<string, CustomEmoji>;
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
  /** Message to flash after a jump (search result); cleared when another channel opens. */
  highlightId: string | null;
  /** Bumps on every highlight so jumping to the same message again re-triggers the flash. */
  highlightNonce: number;
  /** Thread starters known to be deleted: their replies are dropped and never shown again (HD-R7). */
  deletedParents: Record<string, true>;
  /** Monotonic local clock, bumped whenever a starter's counters change from a live source. */
  countClock: number;
  /** Clock value at the last live counter change per starter id (thread.counts or a live reply bump). */
  countMarks: Record<string, number>;
};

export type ChatEvent =
  | HubFrame
  | { t: 'local.bootstrap'; bootstrap: Bootstrap }
  /** `startMark`: `countClock` when the fetch started; a page never overwrites counters changed live since. */
  | { t: 'local.history'; channelId: string; page: HistoryPage; mode: 'replace' | 'prepend'; startMark?: number }
  | { t: 'local.thread'; page: ThreadPage; startMark?: number }
  | { t: 'local.open'; channelId: string }
  | { t: 'local.openThread'; parentId: string | null }
  | { t: 'local.highlight'; messageId: string | null }
  | { t: 'local.focus'; focused: boolean }
  | { t: 'local.pending'; pending: PendingSend[] }
  | { t: 'local.connection'; state: SocketState }
  | { t: 'local.tick'; now: number }
  /** The socket reconnected: other channels' cached windows and threads may hide missed deletions. */
  | { t: 'local.reconnected' }
  /** A thread fetch found its starter gone. */
  | { t: 'local.threadGone'; parentId: string };

export function initialChat(me: string): ChatState {
  return {
    me,
    bootstrap: null,
    channels: {},
    windows: {},
    threads: {},
    customEmoji: {},
    archived: {},
    pending: [],
    presence: {},
    typing: [],
    lastSeen: {},
    connection: 'connecting',
    openChannelId: null,
    openThreadId: null,
    focused: true,
    highlightId: null,
    highlightNonce: 0,
    deletedParents: {},
    countClock: 0,
    countMarks: {},
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

const NO_FILES: FileInfo[] = [];

/**
 * The one way every renderer reads messages: tombstones stay in state (seq continuity, "deleted wins"
 * merging) but are never shown. Returns the same array when nothing is hidden.
 */
export function liveMessages(list: Message[]): Message[] {
  return list.some((m) => m.deletedAt !== null) ? list.filter((m) => m.deletedAt === null) : list;
}

/** Forget a deleted starter's replies (every window, the thread cache) and close its thread. */
function dropThread(s: ChatState, pid: string): ChatState {
  let windows = s.windows;
  for (const [cid, w] of Object.entries(s.windows)) {
    if (w.messages.some((m) => m.parentId === pid)) {
      windows = { ...windows, [cid]: { ...w, messages: w.messages.filter((m) => m.parentId !== pid) } };
    }
  }
  const hasThread = pid in s.threads;
  const threads = hasThread ? Object.fromEntries(Object.entries(s.threads).filter(([k]) => k !== pid)) : s.threads;
  const marked = s.deletedParents[pid] === true;
  const closes = s.openThreadId === pid;
  if (windows === s.windows && !hasThread && marked && !closes) return s;
  return {
    ...s,
    windows,
    threads,
    deletedParents: marked ? s.deletedParents : { ...s.deletedParents, [pid]: true },
    openThreadId: closes ? null : s.openThreadId,
  };
}

/** A starter tombstone (frame, history page, catch-up) takes its replies with it. */
function cascadeTombstones(s: ChatState, list: Message[]): ChatState {
  let next = s;
  for (const m of list) if (m.parentId === null && m.deletedAt !== null) next = dropThread(next, m.id);
  return next;
}

function markCounts(s: ChatState, pid: string): ChatState {
  const countClock = s.countClock + 1;
  return { ...s, countClock, countMarks: { ...s.countMarks, [pid]: countClock } };
}

/** Held version of a starter, from a window or a cached thread. */
function heldStarter(s: ChatState, m: Message): Message | undefined {
  return s.windows[m.channelId]?.messages.find((x) => x.id === m.id) ?? s.threads[m.id]?.parent;
}

/** Keep a starter's held counters when they changed live after the fetch of `m` started. */
function guardCounts(s: ChatState, m: Message, startMark: number | undefined): Message {
  if (startMark === undefined || m.parentId !== null || (s.countMarks[m.id] ?? 0) <= startMark) return m;
  const held = heldStarter(s, m);
  if (!held || (held.replyCount === m.replyCount && held.lastReplyAt === m.lastReplyAt)) return m;
  return { ...m, replyCount: held.replyCount, lastReplyAt: held.lastReplyAt };
}

/** thread.counts: the server's exact live counters; the only path that may lower them. */
function applyCounts(s: ChatState, f: Extract<HubFrame, { t: 'thread.counts' }>): ChatState {
  const set = (p: Message): Message =>
    p.deletedAt !== null || (p.replyCount === f.replyCount && p.lastReplyAt === f.lastReplyAt)
      ? p
      : { ...p, replyCount: f.replyCount, lastReplyAt: f.lastReplyAt };
  let next = s;
  const w = s.windows[f.channelId];
  const i = w ? w.messages.findIndex((x) => x.id === f.parentId) : -1;
  const held = i !== -1 || f.parentId in s.threads;
  if (w && i !== -1) {
    const updated = set(w.messages[i]!);
    if (updated !== w.messages[i]) {
      next = { ...next, windows: { ...next.windows, [f.channelId]: { ...w, messages: w.messages.map((x, j) => (j === i ? updated : x)) } } };
    }
  }
  const t = next.threads[f.parentId];
  if (t) {
    const parent = set(t.parent);
    if (parent !== t.parent) next = { ...next, threads: { ...next.threads, [f.parentId]: { ...t, parent } } };
  }
  return held ? markCounts(next, f.parentId) : next;
}

/** Pick between a held message and an incoming copy; a replay never reverts newer edits or deletes. */
function pick(held: Message | undefined, incoming: Message): Message {
  if (!held) return incoming;
  let winner: Message;
  if (held.deletedAt !== null && incoming.deletedAt === null) winner = held;
  else if (held.deletedAt === null && incoming.deletedAt !== null) winner = incoming;
  else winner = (held.editedAt ?? 0) > (incoming.editedAt ?? 0) ? held : incoming;
  // P3-R13: frames without `reactions` (edits, deletes, duplicate acks) never wipe what is held.
  const reactions = incoming.reactions ?? held.reactions;
  // Phase 4: same rule for `files`; a deleted message has none.
  const files = winner.deletedAt !== null ? (winner.files?.length === 0 ? winner.files : NO_FILES) : (incoming.files ?? held.files);
  if (winner.reactions === reactions && winner.files === files) return winner;
  return { ...winner, reactions, ...(files !== undefined ? { files } : {}) };
}

/** Toggle one user's reaction on a message; the same object when nothing changes. */
function reactOn(m: Message, emoji: string, userId: string, on: boolean): Message {
  const list = m.reactions ?? [];
  const i = list.findIndex((r) => r.emoji === emoji);
  if (on) {
    if (i === -1) return { ...m, reactions: [...list, { emoji, userIds: [userId] }] };
    if (list[i]!.userIds.includes(userId)) return m;
    return { ...m, reactions: list.map((r, j) => (j === i ? { ...r, userIds: [...r.userIds, userId] } : r)) };
  }
  if (i === -1 || !list[i]!.userIds.includes(userId)) return m;
  const userIds = list[i]!.userIds.filter((u) => u !== userId);
  const reactions =
    userIds.length === 0 ? list.filter((_, j) => j !== i) : list.map((r, j) => (j === i ? { ...r, userIds } : r));
  return { ...m, reactions };
}

function applyReaction(s: ChatState, f: Extract<HubFrame, { t: 'reaction' }>): ChatState {
  const upd = (m: Message): Message => (m.id === f.messageId ? reactOn(m, f.emoji, f.userId, f.on) : m);
  const mapAll = (list: Message[]): Message[] => {
    const out = list.map(upd);
    return out.some((m, i) => m !== list[i]) ? out : list;
  };
  let windows = s.windows;
  const w = s.windows[f.channelId];
  if (w) {
    const messages = mapAll(w.messages);
    if (messages !== w.messages) windows = { ...windows, [f.channelId]: { ...w, messages } };
  }
  let threads = s.threads;
  for (const [pid, t] of Object.entries(s.threads)) {
    const parent = upd(t.parent);
    const replies = mapAll(t.replies);
    if (parent !== t.parent || replies !== t.replies) {
      if (threads === s.threads) threads = { ...threads };
      threads[pid] = { parent, replies };
    }
  }
  return windows === s.windows && threads === s.threads ? s : { ...s, windows, threads };
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
  const orphan = m.parentId !== null && s.deletedParents[m.parentId] === true;
  const isNew = m.seq > prev && !known && !orphan;
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

  if (orphan) return next;

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
  return cascadeTombstones(next, [m]);
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
  return markCounts(next, pid);
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
      return cascadeTombstones(replaceEverywhere(state, e.message), [e.message]);
    case 'catchup': {
      let s = state;
      for (const m of [...e.messages].sort((a, b) => a.seq - b.seq)) s = applyMessage(s, m);
      // The catchup presence list is a full snapshot: anyone not in it is away (dropped from the map).
      const presence: Record<string, PresenceState> = {};
      for (const p of e.presence) presence[p.userId] = p.state;
      return { ...s, presence };
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
    case 'reaction':
      return applyReaction(state, e);
    case 'emoji.update': {
      const gone = new Set(e.removed);
      const customEmoji: Record<string, CustomEmoji> = {};
      for (const [name, c] of Object.entries(state.customEmoji)) if (!gone.has(c.id)) customEmoji[name] = c;
      for (const c of e.added) customEmoji[c.name] = c;
      return { ...state, customEmoji };
    }
    case 'thread.counts':
      return applyCounts(state, e);
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
      const customEmoji = e.bootstrap.customEmoji
        ? Object.fromEntries(e.bootstrap.customEmoji.map((c) => [c.name, c]))
        : state.customEmoji;
      return { ...state, me: e.bootstrap.me.id, bootstrap: e.bootstrap, channels, customEmoji };
    }
    case 'local.history': {
      const old = state.windows[e.channelId];
      const pageMessages = e.page.messages.map((m) => guardCounts(state, m, e.startMark));
      const maxSeq = pageMessages.reduce((a, m) => Math.max(a, m.seq), 0);
      const messages =
        e.mode === 'replace' || !old
          ? mergeMessages(
              [],
              [...pageMessages, ...(old && e.mode === 'replace' ? old.messages.filter((m) => m.seq > maxSeq) : [])],
            )
          : mergeMessages(old.messages, pageMessages);
      return cascadeTombstones(
        {
          ...state,
          windows: { ...state.windows, [e.channelId]: { messages, hasOlder: e.page.hasMore, loaded: true } },
        },
        messages,
      );
    }
    case 'local.thread': {
      if (e.page.parent.deletedAt !== null) return dropThread(replaceParentInWindow(state, e.page.parent), e.page.parent.id);
      const page = { ...e.page, parent: guardCounts(state, e.page.parent, e.startMark) };
      const s = { ...state, threads: { ...state.threads, [page.parent.id]: page } };
      return replaceParentInWindow(s, page.parent);
    }
    case 'local.threadGone':
      return dropThread(state, e.parentId);
    case 'local.reconnected': {
      const windows: Record<string, ChannelWindow> = {};
      for (const [cid, w] of Object.entries(state.windows)) if (cid === state.openChannelId) windows[cid] = w;
      const threads: Record<string, ThreadPage> = {};
      for (const [pid, t] of Object.entries(state.threads)) if (pid === state.openThreadId) threads[pid] = t;
      const deletedParents: Record<string, true> = {};
      if (state.openThreadId && state.deletedParents[state.openThreadId]) deletedParents[state.openThreadId] = true;
      return { ...state, windows, threads, deletedParents };
    }
    case 'local.open': {
      const c = state.channels[e.channelId];
      return {
        ...state,
        openChannelId: e.channelId,
        highlightId: null,
        channels: c ? { ...state.channels, [c.id]: zeroCounts(c) } : state.channels,
      };
    }
    case 'local.openThread':
      return { ...state, openThreadId: e.parentId };
    case 'local.highlight':
      return e.messageId === null && state.highlightId === null
        ? state
        : { ...state, highlightId: e.messageId, highlightNonce: e.messageId === null ? state.highlightNonce : state.highlightNonce + 1 };
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
