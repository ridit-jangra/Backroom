import { useEffect, useMemo, useRef, useState } from 'react';
import {
  HISTORY_DEFAULT,
  MARK_READ_INTERVAL_MS,
  type Bootstrap,
  type ClientFrame,
  type FileInfo,
  type HistoryPage,
  type HubFrame,
  type ThreadPage,
} from '@backroom/protocol';
import { api, ApiClientError } from '../api';
import { desktopNotify, isDesktop } from '../desktop/bridge';
import { navigate } from '../nav';
import { notificationText, showNotification } from '../notifications';
import { initialChat, isViewing, lastSeenFor, reduce, type ChatEvent, type ChatState } from '../state/chat';
import { Outbox } from './outbox';
import { HubSocket, wsUrl } from './socket';

export type ChatActions = {
  open(channelId: string): void;
  loadOlder(channelId: string): Promise<void>;
  openThread(parentId: string | null): void;
  /** False when the frame could not be sent (not connected). */
  markThreadRead(messageId: string, seq: number): boolean;
  send(channelId: string, body: string, parentId?: string | null, alsoInChannel?: boolean, files?: FileInfo[]): void;
  /** Opens the message's channel (or thread, for a reply) and highlights it; false when it could not be found. */
  jumpTo(t: { channelId: string; messageId: string; seq: number; parentId: string | null; alsoInChannel: boolean }): Promise<boolean | 'deleted'>;
  retry(clientId: string): void;
  discard(clientId: string): void;
  /** False when the frame could not be sent (not connected); the caller keeps the user's input. */
  edit(messageId: string, body: string): boolean;
  remove(messageId: string): boolean;
  react(messageId: string, emoji: string, on: boolean): boolean;
  typing(channelId: string, parentId?: string | null): void;
  /** Re-fetch bootstrap; after a failed first load this also starts the socket. */
  refresh(): Promise<void>;
};

const TICK_MS = 1_000;
const ACTIVITY_EVERY_MS = 60_000;
/** P2-R28: a frame naming a user missing from bootstrap.members refetches bootstrap at most this often. */
export const MEMBER_REFRESH_MS = 10_000;
/** emoji.update frames arriving within this window are applied as one state change. */
export const EMOJI_COALESCE_MS = 50;
/** After a reconnect the open channel/thread refetch runs at most this often (reconnect storms coalesce). */
export const RECONNECT_REFETCH_MS = 2_000;

/** User IDs a hub frame refers to (authors, typers, presence). */
function frameUserIds(f: HubFrame): string[] {
  switch (f.t) {
    case 'ack':
    case 'message.new':
    case 'message.edit':
    case 'message.delete':
      return [f.message.userId];
    case 'catchup':
      return [...f.messages.map((m) => m.userId), ...f.presence.map((p) => p.userId)];
    case 'presence':
    case 'typing':
    case 'reaction':
      return [f.userId];
    default:
      return [];
  }
}

const historyUrl = (channelId: string, before?: number) =>
  `/channels/${encodeURIComponent(channelId)}/messages?${before !== undefined ? `before=${before}&` : ''}limit=${HISTORY_DEFAULT}`;

const isUnauthorized = (err: unknown) => err instanceof ApiClientError && err.status === 401;

/**
 * One mounted chat session: REST bootstrap/history, the hub socket and the outbox feeding the reducer.
 * State lives in a local variable so socket callbacks always see the latest value; `publish` mirrors it to React.
 */
function startSession(
  slug: string,
  publish: (s: ChatState) => void,
  reportError: (msg: string) => void,
  reportThreadError: (parentId: string | null) => void,
): { actions: ChatActions; stop: () => void } {
  let alive = true;
  let state = initialChat('');
  /** Last mark_read time per channel: the throttle is per channel so switching channels quickly still marks each one. */
  const lastMarkAt = new Map<string, number>();
  let lastMemberRefreshAt = Number.NEGATIVE_INFINITY;
  const markSent = new Map<string, number>();
  let lastActivityAt = Number.NEGATIVE_INFINITY;
  const olderLoading = new Map<string, Promise<void>>();
  const latestLoads = new Map<string, Promise<void>>();
  const MAX_JUMP_PAGES = 20;

  const toLogin = () => {
    if (alive) navigate('/login', { replace: true });
  };
  const fail = (err: unknown) => {
    if (isUnauthorized(err)) toLogin();
  };

  let socket: HubSocket; // assigned below; only used after the first bootstrap resolves
  let started = false;
  /** The socket starts after the first bootstrap so `hello.lastSeen` reflects the server's lastSeq values. */
  async function startup() {
    if (await loadBootstrap()) {
      started = true;
      socket.start();
    }
  }
  const sendFrame = (f: ClientFrame): boolean => alive && socket.send(f);

  /** Applies events in order and publishes once. */
  const apply = (events: ChatEvent[]) => {
    if (!alive || events.length === 0) return;
    const now = Date.now();
    let next = state;
    for (const e of events) next = reduce(next, e, now);
    if (next === state) return;
    state = next;
    publish(next);
    maybeMarkRead();
  };

  /** emoji.update frames waiting to be applied together (a bulk import sends one per emoji). */
  let emojiQueue: ChatEvent[] = [];
  let emojiTimer: ReturnType<typeof setTimeout> | null = null;
  const takeEmojiQueue = (): ChatEvent[] => {
    if (emojiTimer !== null) clearTimeout(emojiTimer);
    emojiTimer = null;
    const q = emojiQueue;
    emojiQueue = [];
    return q;
  };
  const queueEmojiUpdate = (f: ChatEvent) => {
    emojiQueue.push(f);
    emojiTimer ??= setTimeout(() => apply(takeEmojiQueue()), EMOJI_COALESCE_MS);
  };

  /** Any other event first applies queued emoji updates, so the reducer always sees frames in arrival order. */
  const dispatch = (e: ChatEvent) => apply(emojiQueue.length > 0 ? [...takeEmojiQueue(), e] : [e]);

  /** mark_read for the viewed channel when it has unread messages, at most once per MARK_READ_INTERVAL_MS per channel. */
  function maybeMarkRead() {
    const cid = state.openChannelId;
    if (!cid || !isViewing(state, cid)) return;
    const c = state.channels[cid];
    if (!c || c.lastSeq <= Math.max(c.lastReadSeq, markSent.get(cid) ?? 0)) return;
    const now = Date.now();
    if (now - (lastMarkAt.get(cid) ?? Number.NEGATIVE_INFINITY) < MARK_READ_INTERVAL_MS) return;
    if (sendFrame({ t: 'mark_read', channelId: cid, seq: c.lastSeq })) {
      lastMarkAt.set(cid, now);
      markSent.set(cid, c.lastSeq);
    }
  }

  /** P3-R20: rev of the custom emoji list in `state`, sent back so an unchanged list is not re-sent. */
  let emojiRev: number | null = null;

  const loadBootstrap = async (): Promise<boolean> => {
    try {
      const q = emojiRev === null ? '' : `?emojiRev=${emojiRev}`;
      const b = await api<Bootstrap>(`/w/${encodeURIComponent(slug)}/bootstrap${q}`);
      if (!alive) return false;
      dispatch({ t: 'local.bootstrap', bootstrap: b });
      // Only a response that carries the list (or confirms ours) may set the rev we claim to hold.
      if (typeof b.emojiRev === 'number' && (b.customEmoji !== undefined || emojiRev === b.emojiRev)) emojiRev = b.emojiRev;
      return alive;
    } catch (err) {
      if (!alive) return false;
      if (isUnauthorized(err)) toLogin();
      else if (state.bootstrap === null) reportError(err instanceof Error ? err.message : 'Something went wrong');
      return false;
    }
  };

  const loadLatest = (channelId: string) => {
    const startMark = state.countClock;
    return api<HistoryPage>(historyUrl(channelId)).then(
      (page) => dispatch({ t: 'local.history', channelId, page, mode: 'replace', startMark }),
      fail,
    );
  };

  const loadThread = (parentId: string) => {
    const startMark = state.countClock;
    return api<ThreadPage>(`/messages/${encodeURIComponent(parentId)}/thread`).then(
      (page) => {
        if (state.openThreadId !== parentId) return;
        if (alive) reportThreadError(null);
        dispatch({ t: 'local.thread', page, startMark });
      },
      (err) => {
        fail(err);
        // The starter was deleted while we were away: close the panel instead of offering a useless Retry.
        if (alive && err instanceof ApiClientError && err.status === 404 && state.openThreadId === parentId) {
          reportThreadError(null);
          dispatch({ t: 'local.threadGone', parentId });
          return;
        }
        if (alive && !isUnauthorized(err) && state.openThreadId === parentId) reportThreadError(parentId);
      },
    );
  };

  const outbox = new Outbox({
    send: (f) => sendFrame(f),
    onChange: (pending) => dispatch({ t: 'local.pending', pending }),
  });

  const actions: ChatActions = {
    open(channelId) {
      const tid = state.openThreadId;
      const thread = tid ? state.threads[tid] : undefined;
      if (thread && thread.parent.channelId !== channelId) dispatch({ t: 'local.openThread', parentId: null });
      dispatch({ t: 'local.open', channelId });
      latestLoads.set(channelId, loadLatest(channelId));
    },
    loadOlder(channelId) {
      const w = state.windows[channelId];
      const oldest = w?.messages[0]?.seq;
      if (!w?.hasOlder || oldest === undefined || olderLoading.has(channelId)) return Promise.resolve();
      const run = (async () => {
        try {
          const startMark = state.countClock;
          const page = await api<HistoryPage>(historyUrl(channelId, oldest));
          dispatch({ t: 'local.history', channelId, page, mode: 'prepend', startMark });
        } catch (err) {
          fail(err);
        } finally {
          olderLoading.delete(channelId);
        }
      })();
      olderLoading.set(channelId, run);
      return run;
    },
    openThread(parentId) {
      reportThreadError(null);
      dispatch({ t: 'local.openThread', parentId });
      if (parentId !== null) void loadThread(parentId);
    },
    markThreadRead(messageId, seq) {
      return sendFrame({ t: 'mark_thread_read', messageId, seq });
    },
    send(channelId, body, parentId = null, alsoInChannel = false, files = []) {
      if (alive) outbox.enqueue({ channelId, parentId: parentId ?? null, body, alsoInChannel, files });
    },
    async jumpTo({ channelId, messageId, parentId, alsoInChannel }) {
      // P4-R9: open the channel here so the route effect's open() is a no-op and the highlight survives.
      if (state.openChannelId !== channelId) actions.open(channelId);
      if (parentId !== null && !alsoInChannel) {
        reportThreadError(null);
        dispatch({ t: 'local.openThread', parentId });
        await loadThread(parentId);
        if (!alive || state.openThreadId !== parentId) return false;
        const page = state.threads[parentId];
        if (!page) return state.deletedParents[parentId] ? 'deleted' : false;
        const reply = page.replies.find((m) => m.id === messageId);
        if (!reply || reply.deletedAt !== null) return 'deleted';
        dispatch({ t: 'local.highlight', messageId });
        return true;
      }
      await (latestLoads.get(channelId) ?? loadLatest(channelId));
      const held = () => state.windows[channelId]?.messages.find((m) => m.id === messageId);
      const has = () => {
        const m = held();
        return !!m && m.deletedAt === null;
      };
      for (let pages = 0; alive && !held() && state.windows[channelId]?.hasOlder && pages < MAX_JUMP_PAGES; pages++) {
        const inflight = olderLoading.get(channelId);
        if (inflight) {
          // Another load (e.g. scrolling) is running: wait for it and re-check instead of giving up.
          await inflight;
          continue;
        }
        const before = state.windows[channelId]?.messages[0]?.seq;
        await actions.loadOlder(channelId);
        if (state.windows[channelId]?.messages[0]?.seq === before) break;
      }
      // The user may have switched channels while pages loaded.
      if (!alive || state.openChannelId !== channelId) return false;
      if (held()?.deletedAt != null) return 'deleted';
      if (!has()) return parentId !== null && state.deletedParents[parentId] ? 'deleted' : false;
      dispatch({ t: 'local.highlight', messageId });
      return true;
    },
    retry: (clientId) => outbox.retry(clientId),
    discard: (clientId) => outbox.discard(clientId),
    edit: (messageId, body) => sendFrame({ t: 'edit', messageId, body }),
    remove: (messageId) => sendFrame({ t: 'delete', messageId }),
    react: (messageId, emoji, on) => sendFrame({ t: 'react', messageId, emoji, on }),
    typing(channelId, parentId = null) {
      sendFrame(parentId ? { t: 'typing', channelId, parentId } : { t: 'typing', channelId });
    },
    async refresh() {
      if (started) {
        await loadBootstrap();
        return;
      }
      reportError('');
      await startup();
    },
  };

  /** Reconnect refetch: one page of the open channel and the open thread, at most every RECONNECT_REFETCH_MS. */
  let connects = 0;
  let lastRefetchAt = Number.NEGATIVE_INFINITY;
  let refetchTimer: ReturnType<typeof setTimeout> | null = null;
  const refetchVisible = () => {
    refetchTimer = null;
    if (!alive) return;
    lastRefetchAt = Date.now();
    const cid = state.openChannelId;
    if (cid) latestLoads.set(cid, loadLatest(cid));
    if (state.openThreadId) void loadThread(state.openThreadId);
  };
  const refetchOnConnect = () => {
    if (refetchTimer !== null) return;
    const wait = lastRefetchAt + RECONNECT_REFETCH_MS - Date.now();
    if (wait <= 0) refetchVisible();
    else refetchTimer = setTimeout(refetchVisible, wait);
  };

  const onOpen = () => {
    // The hub may have missed read markers sent just before the drop; let them go out again.
    markSent.clear();
    lastMarkAt.clear();
    sendFrame({ t: 'hello', lastSeen: lastSeenFor(state) });
    sendFrame({ t: 'activity' });
    lastActivityAt = Date.now();
    outbox.flush();
    // Edits and deletes carry no seq, so refetch counts and whatever is on screen after every (re)connect.
    // The open window/thread are refetched on EVERY connect, the first included: open() may have loaded them
    // long before the socket came up, and a deletion in between is never delivered by seq catch-up.
    void loadBootstrap();
    // Catch-up is `seq > lastSeen`: a deletion of something we already hold never arrives that way. On a
    // reconnect, forget every other channel's cached window now (refetched when opened); the first connect
    // follows a fresh bootstrap, so nothing else can be stale.
    if (connects++ > 0) dispatch({ t: 'local.reconnected' });
    refetchOnConnect();
  };

  /** P2-R28: a user unknown to bootstrap (e.g. joined since) triggers a throttled bootstrap refetch. */
  const checkMembers = (f: HubFrame) => {
    const members = state.bootstrap?.members;
    if (!members) return;
    const ids = frameUserIds(f);
    if (ids.length === 0 || ids.every((id) => members.some((m) => m.id === id))) return;
    const now = Date.now();
    if (now - lastMemberRefreshAt < MEMBER_REFRESH_MS) return;
    lastMemberRefreshAt = now;
    void loadBootstrap();
  };

  const onFrame = (f: HubFrame) => {
    // Where the open thread lives, read before `stale` drops its page.
    const tid = state.openThreadId;
    const threadChannel = tid ? (state.threads[tid]?.parent.channelId ?? state.openChannelId) : null;
    if (f.t === 'emoji.update') {
      queueEmojiUpdate(f);
      return;
    }
    dispatch(f);
    checkMembers(f);
    if (f.t === 'ack') outbox.ack(f.clientId);
    else if (f.t === 'nack') outbox.nack(f.clientId, f.code);
    else if (f.t === 'stale') {
      if (state.openChannelId === f.channelId) void loadLatest(f.channelId);
      // `stale` dropped the open thread's page; refetch it or the panel would stay on "Loading…".
      if (tid && state.openThreadId === tid && threadChannel === f.channelId && !state.threads[tid]) void loadThread(tid);
    } else if (f.t === 'notify') {
      const text = notificationText(f, { channels: state.channels, members: state.bootstrap?.members ?? [], me: state.me });
      if (isDesktop()) {
        // The shell owns permission; notify whenever the user is not looking at that channel.
        if (!isViewing(state, f.channelId)) void desktopNotify({ ...text, channelId: f.channelId });
        return;
      }
      showNotification(f, {
        viewing: isViewing(state, f.channelId),
        ...text,
        onClick: () => {
          if (!alive) return;
          navigate(`/client/${encodeURIComponent(slug)}/${encodeURIComponent(f.channelId)}`);
          if (f.parentId) actions.openThread(f.parentId);
        },
      });
    }
  };

  socket = new HubSocket({
    url: wsUrl(slug),
    onFrame,
    onOpen,
    onState: (st) => dispatch({ t: 'local.connection', state: st }),
    onAuthLost: toLogin,
    probeAuth: () =>
      api('/me').then(
        () => true,
        (err) => !isUnauthorized(err),
      ),
  });

  const tick = setInterval(() => {
    dispatch({ t: 'local.tick', now: Date.now() });
    outbox.tick();
    maybeMarkRead();
  }, TICK_MS);

  const onActivity = () => {
    const now = Date.now();
    if (now - lastActivityAt >= ACTIVITY_EVERY_MS && sendFrame({ t: 'activity' })) lastActivityAt = now;
  };
  const onFocus = () => dispatch({ t: 'local.focus', focused: true });
  const onBlur = () => dispatch({ t: 'local.focus', focused: false });
  const onVisibility = () =>
    dispatch({ t: 'local.focus', focused: document.visibilityState === 'visible' && document.hasFocus() });
  window.addEventListener('keydown', onActivity);
  window.addEventListener('pointerdown', onActivity);
  window.addEventListener('focus', onFocus);
  window.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', onVisibility);
  // A tab opened in the background never sees blur/visibilitychange, so read the real focus now.
  dispatch({ t: 'local.focus', focused: document.visibilityState === 'visible' && document.hasFocus() });

  void startup();

  return {
    actions,
    stop() {
      alive = false;
      clearInterval(tick);
      takeEmojiQueue();
      if (refetchTimer !== null) clearTimeout(refetchTimer);
      window.removeEventListener('keydown', onActivity);
      window.removeEventListener('pointerdown', onActivity);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
      socket.stop();
    },
  };
}

export function useChat(slug: string): { state: ChatState; actions: ChatActions; error: string; threadError: string | null } {
  const [state, setState] = useState<ChatState>(() => initialChat(''));
  const [error, setError] = useState('');
  const [threadError, setThreadError] = useState<string | null>(null);
  const impl = useRef<ChatActions | null>(null);

  useEffect(() => {
    setState(initialChat(''));
    setError('');
    setThreadError(null);
    const session = startSession(slug, setState, setError, setThreadError);
    impl.current = session.actions;
    return () => {
      session.stop();
      if (impl.current === session.actions) impl.current = null;
    };
  }, [slug]);

  // Stable identity across renders; each call goes to the current session.
  const actions = useMemo<ChatActions>(
    () => ({
      open: (id) => impl.current?.open(id),
      loadOlder: (id) => impl.current?.loadOlder(id) ?? Promise.resolve(),
      openThread: (id) => impl.current?.openThread(id),
      markThreadRead: (id, seq) => impl.current?.markThreadRead(id, seq) ?? false,
      send: (cid, body, pid, also, files) => impl.current?.send(cid, body, pid, also, files),
      jumpTo: (t) => impl.current?.jumpTo(t) ?? Promise.resolve(false),
      retry: (id) => impl.current?.retry(id),
      discard: (id) => impl.current?.discard(id),
      edit: (id, body) => impl.current?.edit(id, body) ?? false,
      remove: (id) => impl.current?.remove(id) ?? false,
      react: (id, emoji, on) => impl.current?.react(id, emoji, on) ?? false,
      typing: (cid, pid) => impl.current?.typing(cid, pid),
      refresh: () => impl.current?.refresh() ?? Promise.resolve(),
    }),
    [],
  );

  return { state, actions, error, threadError };
}
