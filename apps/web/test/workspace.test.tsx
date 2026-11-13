import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Bootstrap, Message } from '@backroom/protocol';
import { Workspace } from '../src/pages/Workspace';
import { App } from '../src/App';
import { FakeWebSocket } from './fakeSocket';

const id = (p: string) => p.padEnd(26, '0');
const GEN = id('01JGENERAL');
const RAND = id('01JRANDOM');
const ME = id('01JME');
const BOB = id('01JBOB');
const ANN = id('01JANN');

function chan(cid: string, name: string, o: Partial<Bootstrap['channels'][number]> = {}): Bootstrap['channels'][number] {
  return {
    id: cid, kind: 'public', name, topic: null, createdBy: ME, dmUserIds: null,
    lastSeq: 0, lastReadSeq: 0, unreadCount: 0, mentionCount: 0, ...o,
  };
}

function makeBootstrap(o: Partial<Bootstrap> = {}): Bootstrap {
  return {
    workspace: { id: 'w', slug: 'clubhack', name: 'Club Hack' },
    me: { id: ME, email: 'me@example.com', displayName: 'Me', role: 'member' },
    channels: [chan(GEN, 'general'), chan(RAND, 'random')],
    members: [
      { id: ME, displayName: 'Me', role: 'member', avatarKey: null },
      { id: BOB, displayName: 'Bob', role: 'member', avatarKey: null },
      { id: ANN, displayName: 'Ann', role: 'owner', avatarKey: null },
    ],
    ...o,
  };
}

let mid = 0;
function msg(seq: number, o: Partial<Message> = {}): Message {
  mid++;
  return {
    id: id(`01JM${mid}X`), channelId: GEN, seq, userId: BOB, parentId: null, body: `message ${seq}`,
    alsoInChannel: false, createdAt: 1_700_000_000_000 + seq * 1000, editedAt: null, deletedAt: null,
    replyCount: 0, lastReplyAt: null, ...o,
  };
}

type Pages = Record<string, { messages: Message[]; hasMore: boolean }>;
let calls: string[] = [];

function stub(opts: { bootstrap?: Bootstrap; pages?: Pages; logout?: number | 'network'; older?: Pages } = {}) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url);
      if (/\/bootstrap(\?|$)/.test(url)) return new Response(JSON.stringify(opts.bootstrap ?? makeBootstrap()), { status: 200 });
      if (url === '/me') return new Response(JSON.stringify({ id: ME }), { status: 200 });
      const hist = /^\/channels\/([0-9A-Z]{26})\/messages\?(.*)$/.exec(url);
      if (hist) {
        const before = new URLSearchParams(hist[2]).get('before');
        const page = before ? opts.older?.[hist[1]!] : opts.pages?.[hist[1]!];
        return new Response(JSON.stringify(page ?? { messages: [], hasMore: false }), { status: 200 });
      }
      if (url === '/auth/logout') {
        const s = opts.logout ?? 200;
        if (s === 'network') throw new TypeError('offline');
        return new Response(JSON.stringify(s === 200 ? { ok: true } : { error: { code: 'x', message: 'x' } }), { status: s });
      }
      return new Response(JSON.stringify({ error: { code: 'not_found', message: 'nf' } }), { status: 404 });
    }),
  );
}

beforeEach(() => {
  FakeWebSocket.reset();
  vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  history.replaceState(null, '', '/');
});

function sock(i = 0): FakeWebSocket {
  const w = FakeWebSocket.instances[i];
  if (!w) throw new Error('no socket ' + i);
  return w;
}
const frames = (w: FakeWebSocket) => w.sent.map((s) => JSON.parse(s) as { t: string; [k: string]: unknown });

/** Render the app at a channel URL and open the socket. */
async function boot(opts: Parameters<typeof stub>[0] = {}, path = `/client/clubhack/${GEN}`) {
  stub(opts);
  history.replaceState(null, '', path);
  render(<App />);
  await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
  act(() => sock().open());
  return sock();
}

const log = () => screen.getByRole('log', { name: 'Messages' });

describe('Workspace live view', () => {
  it('sends hello with lastSeen from bootstrap on open', async () => {
    const ws = await boot({
      bootstrap: makeBootstrap({ channels: [chan(GEN, 'general', { lastSeq: 5, lastReadSeq: 5 }), chan(RAND, 'random', { lastSeq: 2 })] }),
    });
    expect(ws.url).toBe(`ws://${location.host}/ws?workspace=clubhack`);
    const f = frames(ws);
    expect(f[0]).toEqual({ t: 'hello', lastSeen: { [GEN]: 5, [RAND]: 2 } });
    expect(f[1]).toEqual({ t: 'activity' });
  });

  it('with no channelId replaces the URL with general', async () => {
    const replace = vi.spyOn(history, 'replaceState');
    stub();
    history.replaceState(null, '', '/client/clubhack');
    render(<App />);
    await waitFor(() => expect(location.pathname).toBe(`/client/clubhack/${GEN}`));
    expect(replace).toHaveBeenLastCalledWith(null, '', `/client/clubhack/${GEN}`);
  });

  it('renders history and appends message.new live', async () => {
    const ws = await boot({ pages: { [GEN]: { messages: [msg(1, { body: 'hello world' })], hasMore: false } } });
    expect(await within(log()).findByText('hello world')).toBeTruthy();
    act(() => ws.receive({ t: 'message.new', message: msg(2, { body: 'second one' }) }));
    expect(await within(log()).findByText('second one')).toBeTruthy();
  });

  it('background message bumps the sidebar badge and bold state', async () => {
    const ws = await boot();
    const random = await screen.findByRole('button', { name: '#random' });
    expect(random.className).not.toContain('unread');
    act(() => ws.receive({ t: 'message.new', message: msg(1, { channelId: RAND, body: `<@${ME}> ping` }) }));
    await waitFor(() => expect(random.className).toContain('unread'));
    expect(screen.getByLabelText('1 mentions')).toBeTruthy();
  });

  it('opening a channel sends mark_read and clears its badge', async () => {
    const ws = await boot({
      bootstrap: makeBootstrap({
        channels: [chan(GEN, 'general'), chan(RAND, 'random', { lastSeq: 7, lastReadSeq: 5, unreadCount: 2, mentionCount: 1 })],
      }),
    });
    expect(await screen.findByLabelText('1 mentions')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '#random' }));
    expect(location.pathname).toBe(`/client/clubhack/${RAND}`);
    await waitFor(() => expect(frames(ws)).toContainEqual({ t: 'mark_read', channelId: RAND, seq: 7 }));
    expect(screen.queryByLabelText('1 mentions')).toBeNull();
    expect(screen.getByRole('button', { name: '#random' }).className).not.toContain('unread');
  });

  it('Load older fetches before=<oldest seq>&limit=50 and prepends', async () => {
    await boot({
      pages: { [GEN]: { messages: [msg(10, { body: 'ten' }), msg(11, { body: 'eleven' })], hasMore: true } },
      older: { [GEN]: { messages: [msg(9, { body: 'nine' })], hasMore: false } },
    });
    await within(log()).findByText('ten');
    await userEvent.click(screen.getByRole('button', { name: 'Load older messages' }));
    await within(log()).findByText('nine');
    expect(calls).toContain(`/channels/${GEN}/messages?before=10&limit=50`);
    const texts = [...log().querySelectorAll('.msg-text')].map((e) => e.textContent);
    expect(texts).toEqual(['nine', 'ten', 'eleven']);
    expect(screen.queryByRole('button', { name: 'Load older messages' })).toBeNull();
  });

  it('groups messages within 5 minutes under one author header', async () => {
    const t0 = 1_700_000_000_000;
    await boot({
      pages: {
        [GEN]: {
          messages: [
            msg(1, { body: 'a', createdAt: t0 }),
            msg(2, { body: 'b', createdAt: t0 + 60_000 }),
            msg(3, { body: 'c', createdAt: t0 + 60_000 + 300_000 }),
            msg(4, { body: 'd', userId: ANN, createdAt: t0 + 400_000 }),
          ],
          hasMore: false,
        },
      },
    });
    await within(log()).findByText('d');
    const authors = [...log().querySelectorAll('.msg-author')].map((e) => e.textContent);
    expect(authors).toEqual(['Bob', 'Bob', 'Ann']);
    expect(log().querySelectorAll('time')).toHaveLength(3);
  });

  it('shows Reconnecting… after the socket closes and hides it after reopen', async () => {
    const ws = await boot();
    await screen.findByRole('button', { name: '#general' });
    expect(screen.queryByText('Reconnecting…')).toBeNull();
    act(() => ws.serverClose(1006));
    expect((await screen.findByRole('status')).textContent).toBe('Reconnecting…');
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(2), { timeout: 2500 });
    act(() => sock(1).open());
    await waitFor(() => expect(screen.queryByText('Reconnecting…')).toBeNull());
    expect(frames(sock(1))[0]!.t).toBe('hello');
  });

  it('typing frame shows "Bob is typing…" for 5 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const ws = await boot();
    await screen.findByRole('button', { name: '#general' });
    act(() => ws.receive({ t: 'typing', channelId: GEN, userId: BOB }));
    expect(await screen.findByText('Bob is typing…')).toBeTruthy();
    act(() => vi.advanceTimersByTime(4000));
    expect(screen.getByText('Bob is typing…')).toBeTruthy();
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.queryByText('Bob is typing…')).toBeNull();
  });

  it('optimistic message shows Sending… then is replaced by the acked message', async () => {
    const ws = await boot();
    const box = await screen.findByLabelText('Message #general');
    fireEvent.change(box, { target: { value: 'hi there' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByText('Sending…')).toBeTruthy();
    const send = frames(ws).find((f) => f.t === 'send')!;
    expect(send).toMatchObject({ channelId: GEN, body: 'hi there' });
    act(() =>
      ws.receive({ t: 'ack', clientId: send.clientId, message: msg(1, { userId: ME, body: 'hi there' }) }),
    );
    await waitFor(() => expect(screen.queryByText('Sending…')).toBeNull());
    expect(within(log()).getAllByText('hi there')).toHaveLength(1);
  });

  it('nack failed shows Retry, which resends the same clientId', async () => {
    const ws = await boot();
    const box = await screen.findByLabelText('Message #general');
    fireEvent.change(box, { target: { value: 'oops' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    const send = frames(ws).find((f) => f.t === 'send')!;
    act(() => ws.receive({ t: 'nack', clientId: send.clientId, code: 'failed' }));
    expect(await screen.findByText('Failed to send')).toBeTruthy();
    ws.sent = [];
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(frames(ws)).toEqual([expect.objectContaining({ t: 'send', clientId: send.clientId, body: 'oops' })]);
    expect(await screen.findByText('Sending…')).toBeTruthy();
    act(() => ws.receive({ t: 'nack', clientId: send.clientId, code: 'failed' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    expect(screen.queryByText('Failed to send')).toBeNull();
    expect(within(log()).queryByText('oops')).toBeNull();
  });

  it("nack rate_limited shows \"You're sending too fast\" on the pending message, with Retry", async () => {
    const ws = await boot();
    const box = await screen.findByLabelText('Message #general');
    fireEvent.change(box, { target: { value: 'flood' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    const send = frames(ws).find((f) => f.t === 'send')!;
    act(() => ws.receive({ t: 'nack', clientId: send.clientId, code: 'rate_limited' }));
    const note = await screen.findByText("You're sending too fast. Wait a moment.");
    expect(note.getAttribute('role')).toBe('alert');
    expect(note.closest('li')!.textContent).toContain('flood');
    expect(screen.queryByText('Failed to send')).toBeNull();
    ws.sent = [];
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(frames(ws)).toEqual([expect.objectContaining({ t: 'send', clientId: send.clientId, body: 'flood' })]);
    await waitFor(() => expect(screen.queryByText("You're sending too fast. Wait a moment.")).toBeNull());
  });

  it('presence frame flips the member dot', async () => {
    const ws = await boot();
    const members = await screen.findByRole('list', { name: 'Members' });
    const bob = within(members).getByText('Bob').closest('li')!;
    expect(within(bob).getByRole('img').getAttribute('aria-label')).toBe('away');
    act(() => ws.receive({ t: 'presence', userId: BOB, state: 'active' }));
    await waitFor(() => expect(within(bob).getByRole('img').getAttribute('aria-label')).toBe('active'));
  });

  it('Edit and Delete appear only on own messages for members', async () => {
    const mine = msg(1, { userId: ME, body: 'my words' });
    const ws = await boot({ pages: { [GEN]: { messages: [mine, msg(2, { body: 'bob words' })], hasMore: false } } });
    const myRow = (await within(log()).findByText('my words')).closest('li')!;
    const bobRow = within(log()).getByText('bob words').closest('li')!;
    expect(within(myRow).getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(within(myRow).getByRole('button', { name: 'Delete' })).toBeTruthy();
    expect(within(bobRow).queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(within(bobRow).queryByRole('button', { name: 'Delete' })).toBeNull();

    const confirm = vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    await userEvent.click(within(myRow).getByRole('button', { name: 'Delete' }));
    expect(confirm).toHaveBeenCalledWith('Delete this message?');
    expect(frames(ws)).toContainEqual({ t: 'delete', messageId: mine.id });

    await userEvent.click(within(myRow).getByRole('button', { name: 'Edit' }));
    const editBox = within(myRow).getByLabelText('Edit message') as HTMLTextAreaElement;
    expect(editBox.value).toBe('my words');
    fireEvent.change(editBox, { target: { value: 'better words' } });
    fireEvent.keyDown(editBox, { key: 'Enter' });
    expect(frames(ws)).toContainEqual({ t: 'edit', messageId: mine.id, body: 'better words' });
  });

  it('owner/admin get Delete (not Edit) on other people’s messages', async () => {
    await boot({
      bootstrap: makeBootstrap({ me: { id: ME, email: 'me@example.com', displayName: 'Me', role: 'owner' } }),
      pages: { [GEN]: { messages: [msg(1, { body: 'bob words' })], hasMore: false } },
    });
    const bobRow = (await within(log()).findByText('bob words')).closest('li')!;
    expect(within(bobRow).getByRole('button', { name: 'Delete' })).toBeTruthy();
    expect(within(bobRow).queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('renders deleted, edited and reply-count states', async () => {
    await boot({
      pages: {
        [GEN]: {
          messages: [
            msg(1, { body: '', deletedAt: 1 }),
            msg(2, { body: 'fixed', editedAt: 2 }),
            msg(3, { body: 'parent', replyCount: 1 }),
            msg(4, { body: 'busy', replyCount: 3 }),
          ],
          hasMore: false,
        },
      },
    });
    expect(await within(log()).findByText('This message was deleted.')).toBeTruthy();
    expect(within(log()).getByText('(edited)')).toBeTruthy();
    expect(within(log()).getByRole('button', { name: '1 reply' })).toBeTruthy();
    expect(within(log()).getByRole('button', { name: '3 replies' })).toBeTruthy();
    // P2-R10: useChat.openThread owns the thread fetch.
    const parent = within(log()).getByText('parent').closest('li')!;
    await userEvent.click(within(parent).getByRole('button', { name: '1 reply' }));
    const parentId = calls.find((u) => u.startsWith('/messages/'));
    expect(parentId).toMatch(/^\/messages\/[0-9A-Z]{26}\/thread$/);
  });

  it('labels DMs by the other participants, or my own name for a self-DM', async () => {
    const DM1 = id('01JDMONE');
    const DM2 = id('01JDMSELF');
    await boot({
      bootstrap: makeBootstrap({
        channels: [
          chan(GEN, 'general'),
          chan(DM1, '', { kind: 'dm', name: null, dmUserIds: [ANN, BOB, ME].sort() }),
          chan(DM2, '', { kind: 'dm', name: null, dmUserIds: [ME] }),
        ],
      }),
    });
    const dms = await screen.findByRole('navigation', { name: 'Direct messages' });
    const labels = within(dms).getAllByRole('button').map((b) => b.textContent);
    expect(labels).toEqual(['Ann, Bob', 'Me']);
  });

  it('shows Admin only for owner/admin', async () => {
    await boot({ bootstrap: makeBootstrap({ me: { id: ME, email: 'me@example.com', displayName: 'Me', role: 'admin' } }) });
    const admin = await screen.findByRole('link', { name: 'Admin' });
    expect(admin.getAttribute('href')).toBe('/client/clubhack/admin');
    await userEvent.click(admin);
    expect(location.pathname).toBe('/client/clubhack/admin');
  });
});

describe('Fix round 1', () => {
  afterEach(() => {
    delete (document as { visibilityState?: unknown }).visibilityState;
    delete (document as { hasFocus?: unknown }).hasFocus;
  });

  it('a tab loaded in the background does not mark the open channel read and still notifies', async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => false });
    const created: string[] = [];
    vi.stubGlobal(
      'Notification',
      class {
        static permission = 'granted';
        onclick: (() => void) | null = null;
        constructor(title: string) {
          created.push(title);
        }
      },
    );
    const ws = await boot();
    const general = await screen.findByRole('button', { name: '#general' });
    act(() => ws.receive({ t: 'message.new', message: msg(1, { body: 'while away' }) }));
    await waitFor(() => expect(general.className).toContain('unread'));
    await new Promise((r) => setTimeout(r, 1100));
    expect(frames(ws).some((f) => f.t === 'mark_read')).toBe(false);
    act(() =>
      ws.receive({ t: 'notify', kind: 'mention', channelId: GEN, messageId: id('01JN'), parentId: null, fromUserId: BOB, preview: 'hi' }),
    );
    expect(created).toEqual(['#general']);
  });

  it('Edit and Delete are disabled while reconnecting', async () => {
    const ws = await boot({ pages: { [GEN]: { messages: [msg(1, { userId: ME, body: 'mine' })], hasMore: false } } });
    const row = (await within(log()).findByText('mine')).closest('li')!;
    expect((within(row).getByRole('button', { name: 'Edit' }) as HTMLButtonElement).disabled).toBe(false);
    act(() => ws.serverClose(1006));
    await screen.findByRole('status');
    for (const name of ['Edit', 'Delete']) {
      const b = within(row).getByRole('button', { name }) as HTMLButtonElement;
      expect(b.disabled).toBe(true);
      expect(b.title).toBe('Reconnecting…');
    }
  });

  it('an edit that cannot be sent keeps the editor open with the typed text', async () => {
    const ws = await boot({ pages: { [GEN]: { messages: [msg(1, { userId: ME, body: 'mine' })], hasMore: false } } });
    const row = (await within(log()).findByText('mine')).closest('li')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    const box = within(row).getByLabelText('Edit message') as HTMLTextAreaElement;
    act(() => ws.serverClose(1006));
    fireEvent.change(box, { target: { value: 'changed' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(within(row).getByRole('alert').textContent).toBe('Not connected — try again.');
    expect((within(row).getByLabelText('Edit message') as HTMLTextAreaElement).value).toBe('changed');
    expect(frames(ws).some((f) => f.t === 'edit')).toBe(false);
  });

  it('a failed first bootstrap offers Try again, which loads and starts the socket', async () => {
    stub();
    const ok = vi.mocked(globalThis.fetch);
    const impl = ok.getMockImplementation()!;
    let first = true;
    ok.mockImplementation(async (url) => {
      if (/\/bootstrap(\?|$)/.test(String(url)) && first) {
        first = false;
        return new Response(JSON.stringify({ error: { code: 'internal', message: 'Server hiccup' } }), { status: 500 });
      }
      return impl(url);
    });
    history.replaceState(null, '', `/client/clubhack/${GEN}`);
    render(<App />);
    expect((await screen.findByRole('alert')).textContent).toBe('Server hiccup');
    expect(FakeWebSocket.instances).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    act(() => sock().open());
    expect(await screen.findByRole('button', { name: '#general' })).toBeTruthy();
  });

  it('read markers are re-sent after a reconnect', async () => {
    const ws = await boot({
      bootstrap: makeBootstrap({ channels: [chan(GEN, 'general', { lastSeq: 5, lastReadSeq: 3 }), chan(RAND, 'random')] }),
    });
    await waitFor(() => expect(frames(ws)).toContainEqual({ t: 'mark_read', channelId: GEN, seq: 5 }));
    act(() => ws.serverClose(1006));
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(2), { timeout: 2500 });
    act(() => sock(1).open());
    await waitFor(() => expect(frames(sock(1))).toContainEqual({ t: 'mark_read', channelId: GEN, seq: 5 }));
  });
});

describe('Workspace sign out', () => {
  it('stays and shows an alert when logout fails', async () => {
    stub({ logout: 'network' });
    history.replaceState(null, '', '/client/clubhack');
    render(<Workspace slug="clubhack" channelId={GEN} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      "Couldn't sign out. Check your connection and try again.",
    );
    expect(location.pathname).toBe('/client/clubhack');
  });

  it('navigates to /login on success and on 401', async () => {
    for (const status of [200, 401]) {
      cleanup();
      stub({ logout: status });
      history.replaceState(null, '', '/client/clubhack');
      render(<Workspace slug="clubhack" />);
      await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
      expect(location.pathname).toBe('/login');
    }
  });
});

describe('navigation', () => {
  it('the / redirect uses replaceState', () => {
    const replace = vi.spyOn(history, 'replaceState');
    const push = vi.spyOn(history, 'pushState');
    stub();
    history.replaceState(null, '', '/');
    replace.mockClear();
    render(<App />);
    expect(replace).toHaveBeenCalledWith(null, '', '/client/clubhack');
    expect(push).not.toHaveBeenCalled();
  });

  it('routes /client/:slug/admin before the channel route and rejects odd channel segments', async () => {
    stub();
    history.replaceState(null, '', '/client/clubhack/admin');
    render(<App />);
    expect(await screen.findByText('You need to be an admin to see this page.')).toBeTruthy();
    cleanup();
    history.replaceState(null, '', '/client/clubhack/not-a-channel');
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Not found' })).toBeTruthy();
  });
});
