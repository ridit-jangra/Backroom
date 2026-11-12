import { useEffect, useMemo, useRef, useState } from 'react';
import {
  HISTORY_DEFAULT,
  MARK_READ_INTERVAL_MS,
  type Bootstrap,
  type ClientFrame,
  type HistoryPage,
  type HubFrame,
  type ThreadPage,
} from '@backroom/protocol';
import { api, ApiClientError } from '../api';
import { navigate } from '../nav';
import { notificationText, showNotification } from '../notifications';
import { initialChat, isViewing, lastSeenFor, reduce, type ChatEvent, type ChatState } from '../state/chat';
import { Outbox } from './outbox';
import { HubSocket, wsUrl } from './socket';

export type ChatActions = {
  open(channelId: string): void;
  loadOlder(channelId: string): Promise<void>;
  openThread(parentId: string | null): void;
  markThreadRead(messageId: string, seq: number): void;
  send(channelId: string, body: string, parentId?: string | null, alsoInChannel?: boolean): void;
  retry(clientId: string): void;
  discard(clientId: string): void;
  edit(messageId: string, body: string): void;
  remove(messageId: string): void;
  typing(channelId: string, parentId?: string | null): void;
  refresh(): Promise<void>;
};

const TICK_MS = 1_000;
const ACTIVITY_EVERY_MS = 60_000;

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
): { actions: ChatActions; stop: () => void } {
  let alive = true;
  let state = initialChat('');
  let lastMarkAt = Number.NEGATIVE_INFINITY;
  const markSent = new Map<string, number>();
  let lastActivityAt = Number.NEGATIVE_INFINITY;
  const olderLoading = new Set<string>();

  const toLogin = () => {
    if (alive) navigate('/login', { replace: true });
  };
  const fail = (err: unknown) => {
    if (isUnauthorized(err)) toLogin();
  };

  let socket: HubSocket; // assigned below; only used after the first bootstrap resolves
  const sendFrame = (f: ClientFrame): boolean => alive && socket.send(f);

  const dispatch = (e: ChatEvent) => {
    if (!alive) return;
    let next = reduce(state, e, Date.now());
    if (e.t === 'local.bootstrap' && next.me !== e.bootstrap.me.id) next = { ...next, me: e.bootstrap.me.id };
    if (next === state) return;
    state = next;
    publish(next);
    maybeMarkRead();
  };

  /** mark_read for the viewed channel when it has unread messages, at most once per MARK_READ_INTERVAL_MS. */
  function maybeMarkRead() {
    const cid = state.openChannelId;
    if (!cid || !isViewing(state, cid)) return;
    const c = state.channels[cid];
    if (!c || c.lastSeq <= Math.max(c.lastReadSeq, markSent.get(cid) ?? 0)) return;
    const now = Date.now();
    if (now - lastMarkAt < MARK_READ_INTERVAL_MS) return;
    if (sendFrame({ t: 'mark_read', channelId: cid, seq: c.lastSeq })) {
      lastMarkAt = now;
      markSent.set(cid, c.lastSeq);
    }
  }

  const loadBootstrap = async (): Promise<boolean> => {
    try {
      const b = await api<Bootstrap>(`/w/${encodeURIComponent(slug)}/bootstrap`);
      dispatch({ t: 'local.bootstrap', bootstrap: b });
      return alive;
    } catch (err) {
      if (!alive) return false;
      if (isUnauthorized(err)) toLogin();
      else if (state.bootstrap === null) reportError(err instanceof Error ? err.message : 'Something went wrong');
      return false;
    }
  };

  const loadLatest = (channelId: string) =>
    api<HistoryPage>(historyUrl(channelId)).then(
      (page) => dispatch({ t: 'local.history', channelId, page, mode: 'replace' }),
      fail,
    );

  const loadThread = (parentId: string) =>
    api<ThreadPage>(`/messages/${encodeURIComponent(parentId)}/thread`).then((page) => {
      if (state.openThreadId === parentId) dispatch({ t: 'local.thread', page });
    }, fail);

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
      void loadLatest(channelId);
    },
    async loadOlder(channelId) {
      const w = state.windows[channelId];
      const oldest = w?.messages[0]?.seq;
      if (!w?.hasOlder || oldest === undefined || olderLoading.has(channelId)) return;
      olderLoading.add(channelId);
      try {
        const page = await api<HistoryPage>(historyUrl(channelId, oldest));
        dispatch({ t: 'local.history', channelId, page, mode: 'prepend' });
      } catch (err) {
        fail(err);
      } finally {
        olderLoading.delete(channelId);
      }
    },
    openThread(parentId) {
      dispatch({ t: 'local.openThread', parentId });
      if (parentId !== null) void loadThread(parentId);
    },
    markThreadRead(messageId, seq) {
      sendFrame({ t: 'mark_thread_read', messageId, seq });
    },
    send(channelId, body, parentId = null, alsoInChannel = false) {
      if (alive) outbox.enqueue({ channelId, parentId: parentId ?? null, body, alsoInChannel });
    },
    retry: (clientId) => outbox.retry(clientId),
    discard: (clientId) => outbox.discard(clientId),
    edit(messageId, body) {
      sendFrame({ t: 'edit', messageId, body });
    },
    remove(messageId) {
      sendFrame({ t: 'delete', messageId });
    },
    typing(channelId, parentId = null) {
      sendFrame(parentId ? { t: 'typing', channelId, parentId } : { t: 'typing', channelId });
    },
    async refresh() {
      await loadBootstrap();
    },
  };

  const onOpen = () => {
    sendFrame({ t: 'hello', lastSeen: lastSeenFor(state) });
    sendFrame({ t: 'activity' });
    lastActivityAt = Date.now();
    outbox.flush();
    // Edits and deletes carry no seq, so refetch counts and whatever is on screen after every (re)connect.
    void loadBootstrap();
    if (state.openChannelId) void loadLatest(state.openChannelId);
    if (state.openThreadId) void loadThread(state.openThreadId);
  };

  const onFrame = (f: HubFrame) => {
    dispatch(f);
    if (f.t === 'ack') outbox.ack(f.clientId);
    else if (f.t === 'nack') outbox.nack(f.clientId, f.code);
    else if (f.t === 'stale' && state.openChannelId === f.channelId) void loadLatest(f.channelId);
    else if (f.t === 'notify') {
      const text = notificationText(f, { channels: state.channels, members: state.bootstrap?.members ?? [], me: state.me });
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

  // The socket starts after the first bootstrap so `hello.lastSeen` reflects the server's lastSeq values.
  void loadBootstrap().then((ok) => {
    if (ok) socket.start();
  });

  return {
    actions,
    stop() {
      alive = false;
      clearInterval(tick);
      window.removeEventListener('keydown', onActivity);
      window.removeEventListener('pointerdown', onActivity);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibility);
      socket.stop();
    },
  };
}

export function useChat(slug: string): { state: ChatState; actions: ChatActions; error: string } {
  const [state, setState] = useState<ChatState>(() => initialChat(''));
  const [error, setError] = useState('');
  const impl = useRef<ChatActions | null>(null);

  useEffect(() => {
    setState(initialChat(''));
    setError('');
    const session = startSession(slug, setState, setError);
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
      markThreadRead: (id, seq) => impl.current?.markThreadRead(id, seq),
      send: (cid, body, pid, also) => impl.current?.send(cid, body, pid, also),
      retry: (id) => impl.current?.retry(id),
      discard: (id) => impl.current?.discard(id),
      edit: (id, body) => impl.current?.edit(id, body),
      remove: (id) => impl.current?.remove(id),
      typing: (cid, pid) => impl.current?.typing(cid, pid),
      refresh: () => impl.current?.refresh() ?? Promise.resolve(),
    }),
    [],
  );

  return { state, actions, error };
}
