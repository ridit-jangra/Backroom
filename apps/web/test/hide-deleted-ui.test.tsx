import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Message } from '@backroom/protocol';
import { render } from '@testing-library/react';
import { App } from '../src/App';
import { FakeWebSocket } from './fakeSocket';
import { ANN, BOB, GEN, ME, RAND, boot, frames, id, msg, stubApi } from './harness';

beforeEach(() => {
  FakeWebSocket.reset();
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  history.replaceState(null, '', '/');
});

const log = () => screen.getByRole('log', { name: 'Messages' });
const tomb = (m: Message): Message => ({ ...m, body: '', editedAt: m.createdAt + 5, deletedAt: m.createdAt + 5, replyCount: 0, lastReplyAt: null });

describe('deleted messages are never rendered', () => {
  it('a tombstone in a history page renders nothing, and a live delete frame removes the row', async () => {
    const gone = msg(1, { body: 'old text' });
    const keep = msg(2, { body: 'kept text' });
    const dying = msg(3, { body: 'dying text' });
    stubApi({ pages: { [GEN]: { messages: [tomb(gone), keep, dying], hasMore: false } } });
    const ws2 = await boot();
    await within(log()).findByText('kept text');
    expect(screen.queryByText(/was deleted/i)).toBeNull();
    expect(log().querySelectorAll('li.msg')).toHaveLength(2);
    act(() => ws2.receive({ t: 'message.delete', message: tomb(dying) }));
    await waitFor(() => expect(within(log()).queryByText('dying text')).toBeNull());
    expect(log().querySelectorAll('li.msg')).toHaveLength(1);
    expect(screen.queryByText(/was deleted/i)).toBeNull();
  });

  it('a hidden tombstone does not break author grouping: same author within 5 minutes still collapses', async () => {
    const a = msg(1, { body: 'first', userId: BOB });
    const t = msg(2, { body: '', userId: ANN, deletedAt: 5 });
    const c = msg(3, { body: 'third', userId: BOB });
    stubApi({ pages: { [GEN]: { messages: [a, t, c], hasMore: false } } });
    await boot();
    await within(log()).findByText('third');
    expect(log().querySelectorAll('.msg-author')).toHaveLength(1);
    expect(within(log()).getByText('third').closest('li')!.className).not.toContain('msg-first');
  });

  it('when the first message of a group is deleted the next one gets the author line', async () => {
    const a = msg(1, { body: 'first', userId: BOB });
    const b = msg(2, { body: 'second', userId: BOB });
    stubApi({ pages: { [GEN]: { messages: [a, b], hasMore: false } } });
    const ws = await boot();
    await within(log()).findByText('second');
    expect(log().querySelectorAll('.msg-author')).toHaveLength(1);
    act(() => ws.receive({ t: 'message.delete', message: tomb(a) }));
    await waitFor(() => expect(within(log()).queryByText('first')).toBeNull());
    expect(log().querySelectorAll('.msg-author')).toHaveLength(1);
    expect(within(log()).getByText('second').closest('li')!.className).toContain('msg-first');
  });

  it('a deleted message shows no reactions, files or toolbar', async () => {
    stubApi({ pages: { [GEN]: { messages: [msg(1, { deletedAt: 5, body: '', reactions: [{ emoji: '+1', userIds: [BOB] }] }), msg(2, { body: 'live' })], hasMore: false } } });
    await boot();
    await within(log()).findByText('live');
    expect(document.querySelector('.reaction')).toBeNull();
    expect(log().querySelectorAll('.msg-toolbar')).toHaveLength(1);
  });

  it('jumping to a deleted message (a stale search hit) shows a clear message', async () => {
    const dead = msg(1, { body: 'x', deletedAt: 5 });
    stubApi({
      pages: { [GEN]: { messages: [dead, msg(2, { body: 'live' })], hasMore: false } },
      route: (url) =>
        url.startsWith('/w/clubhack/search')
          ? { results: [{ message: dead, channel: { id: GEN, name: 'general', kind: 'public', isMember: true }, snippet: [{ text: 'stale hit', hit: true }] }], nextCursor: null }
          : undefined,
    });
    await boot();
    await within(log()).findByText('live');
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search messages' }), 'stale{Enter}');
    await userEvent.click(await screen.findByText('stale hit'));
    expect((await screen.findByRole('alert')).textContent).toBe('That message was deleted.');
  });
});

describe('threads', () => {
  const starter = msg(1, { body: 'starter text', replyCount: 2, lastReplyAt: 1_700_000_003_000, userId: ME });
  const r1 = msg(2, { parentId: starter.id, body: 'reply one' });
  const r2 = msg(3, { parentId: starter.id, body: 'reply two' });

  async function open() {
    stubApi({
      pages: { [GEN]: { messages: [starter], hasMore: false } },
      route: (url) => (url === `/messages/${starter.id}/thread` ? { parent: starter, replies: [r1, r2] } : undefined),
    });
    const ws = await boot();
    await userEvent.click(await screen.findByRole('button', { name: '2 replies' }));
    const panel = await screen.findByRole('complementary', { name: 'Thread' });
    await within(panel).findByText('reply two');
    return { ws, panel };
  }

  it('the thread panel closes when its starter is deleted and shows no placeholder', async () => {
    const { ws } = await open();
    act(() => ws.receive({ t: 'message.delete', message: tomb(starter) }));
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Thread' })).toBeNull());
    expect(screen.queryByText(/was deleted/i)).toBeNull();
    expect(within(log()).queryByText('starter text')).toBeNull();
    expect(screen.queryByRole('button', { name: /repl/ })).toBeNull();
  });

  it('a deleted reply leaves the open thread; counts update and the button disappears at zero', async () => {
    const { ws, panel } = await open();
    act(() => ws.receive({ t: 'message.delete', message: tomb(r1) }));
    act(() => ws.receive({ t: 'thread.counts', channelId: GEN, parentId: starter.id, replyCount: 1, lastReplyAt: r2.createdAt }));
    await waitFor(() => expect(within(panel).queryByText('reply one')).toBeNull());
    expect(within(panel).getByText('reply two')).toBeTruthy();
    expect(within(panel).getByText('1 reply')).toBeTruthy();
    expect(within(log()).getByRole('button', { name: '1 reply' })).toBeTruthy();
    act(() => ws.receive({ t: 'message.delete', message: tomb(r2) }));
    act(() => ws.receive({ t: 'thread.counts', channelId: GEN, parentId: starter.id, replyCount: 0, lastReplyAt: null }));
    await waitFor(() => expect(within(log()).queryByRole('button', { name: /repl/ })).toBeNull());
    expect(within(panel).queryByText(/\d+ repl/)).toBeNull();
    expect(within(panel).queryByText('reply two')).toBeNull();
  });

  it('a reply shown in the channel ("also sent to channel") disappears when deleted', async () => {
    const also = msg(4, { parentId: starter.id, alsoInChannel: true, body: 'also text' });
    stubApi({ pages: { [GEN]: { messages: [starter, also], hasMore: false } } });
    const ws = await boot();
    await within(log()).findByText('also text');
    act(() => ws.receive({ t: 'message.delete', message: tomb(also) }));
    await waitFor(() => expect(within(log()).queryByText('also text')).toBeNull());
  });

  it('a starter delete removes its "also sent to channel" replies from the channel view', async () => {
    const also = msg(4, { parentId: starter.id, alsoInChannel: true, body: 'also text' });
    stubApi({ pages: { [GEN]: { messages: [starter, also], hasMore: false } } });
    const ws = await boot();
    await within(log()).findByText('also text');
    act(() => ws.receive({ t: 'message.delete', message: tomb(starter) }));
    await waitFor(() => expect(within(log()).queryByText('also text')).toBeNull());
    expect(within(log()).queryByText('starter text')).toBeNull();
  });
});

describe('confirm before deleting a starter with replies', () => {
  const starter = msg(1, { body: 'starter text', replyCount: 2, lastReplyAt: 1_700_000_003_000, userId: ME });

  async function setup(m: Message = starter) {
    const confirm = vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    stubApi({ pages: { [GEN]: { messages: [m], hasMore: false } } });
    const ws = await boot();
    const row = (await within(log()).findByText(m.body)).closest('li')!;
    return { ws, row, confirm, del: within(row).getByRole('button', { name: 'Delete' }) };
  }

  it('opens a dialog with the reply count, focus on Cancel, and Cancel deletes nothing', async () => {
    const { ws, confirm, del } = await setup();
    await userEvent.click(del);
    const dlg = await screen.findByRole('dialog', { name: 'Delete this message?' });
    expect(dlg.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.getElementById(dlg.getAttribute('aria-describedby')!)!.textContent).toBe("This also deletes 2 replies. This can't be undone.");
    expect(document.activeElement).toBe(within(dlg).getByRole('button', { name: 'Cancel' }));
    expect(confirm).not.toHaveBeenCalled();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(frames(ws).some((f) => f.t === 'delete')).toBe(false);
    expect(document.activeElement).toBe(del);
  });

  it('says "1 reply" for one reply and Escape cancels', async () => {
    const { ws, del } = await setup(msg(1, { body: 'one reply', replyCount: 1, userId: ME }));
    await userEvent.click(del);
    const dlg = await screen.findByRole('dialog', { name: 'Delete this message?' });
    expect(dlg.textContent).toContain("This also deletes 1 reply. This can't be undone.");
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(frames(ws).some((f) => f.t === 'delete')).toBe(false);
    expect(document.activeElement).toBe(del);
  });

  it('the Delete button confirms and sends the delete frame', async () => {
    const { ws, del } = await setup();
    await userEvent.click(del);
    const dlg = await screen.findByRole('dialog');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Delete' }));
    expect(frames(ws)).toContainEqual({ t: 'delete', messageId: starter.id });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('works with the keyboard alone: Enter opens, Tab moves to Delete, Enter confirms', async () => {
    const { ws, del } = await setup();
    del.focus();
    await userEvent.keyboard('{Enter}');
    const dlg = await screen.findByRole('dialog');
    expect(document.activeElement).toBe(within(dlg).getByRole('button', { name: 'Cancel' }));
    await userEvent.tab();
    expect(document.activeElement).toBe(within(dlg).getByRole('button', { name: 'Delete' }));
    await userEvent.keyboard('{Enter}');
    expect(frames(ws)).toContainEqual({ t: 'delete', messageId: starter.id });
  });

  it('a failed delete keeps the existing alert', async () => {
    const { ws, row, del } = await setup();
    await userEvent.click(del);
    const dlg = await screen.findByRole('dialog');
    act(() => ws.serverClose(1006));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Delete' }));
    expect(within(row).getByRole('alert').textContent).toContain('Not connected');
  });

  it('a plain message and a starter with no replies use no dialog; a reply neither', async () => {
    const plain = await setup(msg(1, { body: 'plain', userId: ME }));
    await userEvent.click(plain.del);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(plain.confirm).toHaveBeenCalledWith('Delete this message?');
    expect(frames(plain.ws)).toContainEqual({ t: 'delete', messageId: expect.any(String) });
    cleanup();
    FakeWebSocket.reset();
    const reply = await setup(msg(2, { body: 'a reply', userId: ME, parentId: id('01JSOMEPARENT'), alsoInChannel: true, replyCount: 3 }));
    await userEvent.click(reply.del);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(frames(reply.ws)).toContainEqual({ t: 'delete', messageId: expect.any(String) });
  });
});

describe('reconnect convergence', () => {
  it('an offline client converges: a message and a cascade-deleted starter vanish after reconnect', async () => {
    const mine = msg(1, { body: 'will be deleted', userId: ME });
    const starter = msg(2, { body: 'starter text', replyCount: 1, lastReplyAt: 1_700_000_004_000 });
    const reply = msg(3, { parentId: starter.id, body: 'reply text' });
    const also = msg(4, { parentId: starter.id, alsoInChannel: true, body: 'also text' });
    const keep = msg(5, { body: 'survivor' });
    let live = true;
    stubApi({
      route: (url) => {
        if (url.startsWith(`/channels/${GEN}/messages`)) {
          return { messages: live ? [mine, starter, also, keep] : [tomb(mine), tomb(starter), tomb(also), keep], hasMore: false };
        }
        if (url === `/messages/${starter.id}/thread`) return { parent: starter, replies: [reply, also] };
        return undefined;
      },
    });
    const ws = await boot();
    await within(log()).findByText('will be deleted');
    await userEvent.click(await screen.findByRole('button', { name: '1 reply' }));
    await screen.findByRole('complementary', { name: 'Thread' });
    act(() => ws.serverClose(1006));
    live = false; // deleted while offline: catch-up (seq > lastSeen) will never carry these tombstones
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(2), { timeout: 3000 });
    act(() => FakeWebSocket.instances[1]!.open());
    await waitFor(() => expect(within(log()).queryByText('will be deleted')).toBeNull(), { timeout: 4000 });
    expect(within(log()).queryByText('starter text')).toBeNull();
    expect(within(log()).queryByText('also text')).toBeNull();
    expect(within(log()).getByText('survivor')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Thread' })).toBeNull());
    expect(screen.queryByText(/was deleted/i)).toBeNull();
  });

  it('every connect refetches the open channel once, including the first', async () => {
    const counts = { n: 0 };
    stubApi({
      route: (url) => {
        if (url.startsWith(`/channels/${GEN}/messages`)) counts.n++;
        return undefined;
      },
    });
    const ws = await boot();
    // open() plus the first connect's refetch
    await waitFor(() => expect(counts.n).toBe(2));
    await new Promise((r) => setTimeout(r, 50));
    expect(counts.n).toBe(2);
    act(() => ws.serverClose(1006));
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(2), { timeout: 3000 });
    act(() => FakeWebSocket.instances[1]!.open());
    // throttled to at most one per 2 s: the reconnect's refetch is a trailing call
    await waitFor(() => expect(counts.n).toBe(3), { timeout: 4000 });
  });

  it('a first connect that is delayed still removes what was deleted meanwhile', async () => {
    const gone = msg(1, { body: 'deleted meanwhile' });
    const keep = msg(2, { body: 'kept' });
    let live = true;
    stubApi({
      route: (url) =>
        url.startsWith(`/channels/${GEN}/messages`) ? { messages: live ? [gone, keep] : [tomb(gone), keep], hasMore: false } : undefined,
    });
    history.replaceState(null, '', `/client/clubhack/${GEN}`);
    render(<App />);
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    await within(log()).findByText('deleted meanwhile');
    live = false; // the hub was unreachable; the socket opens only now
    act(() => FakeWebSocket.instances[0]!.open());
    await waitFor(() => expect(within(log()).queryByText('deleted meanwhile')).toBeNull());
    expect(within(log()).getByText('kept')).toBeTruthy();
  });

  it('a non-open channel is not shown from its stale cache after a reconnect; it is refetched when opened', async () => {
    const stale = msg(1, { channelId: RAND, body: 'stale in random' });
    let randHangs = false;
    let randFetches = 0;
    stubApi({ route: (url) => (url.startsWith(`/channels/${RAND}/messages`) ? { messages: [stale], hasMore: false } : undefined) });
    const base = fetch;
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      if (url.startsWith(`/channels/${RAND}/messages`)) {
        randFetches++;
        if (randHangs) return new Promise<Response>(() => undefined);
      }
      return base(url, init);
    });
    const ws = await boot();
    await userEvent.click(await screen.findByRole('button', { name: '#random' }));
    await within(log()).findByText('stale in random');
    await userEvent.click(screen.getByRole('button', { name: '#general' }));
    act(() => ws.serverClose(1006));
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(2), { timeout: 3000 });
    act(() => FakeWebSocket.instances[1]!.open());
    const fetchedBefore = randFetches;
    expect(fetchedBefore).toBe(1); // nothing refetched for a channel nobody looks at
    // The message was deleted meanwhile; opening #random must not flash the cached copy.
    randHangs = true;
    await userEvent.click(screen.getByRole('button', { name: '#random' }));
    await waitFor(() => expect(randFetches).toBe(2));
    expect(screen.queryByText('stale in random')).toBeNull();
  });
});

describe('fix round 1: focus, frozen count, jumps', () => {
  const mine = (seq: number, body: string, o: Partial<Message> = {}) => msg(seq, { body, userId: ME, ...o });

  it('after a confirmed native delete focus moves to the next row, else the previous row, else the log', async () => {
    vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    const a = mine(1, 'row a');
    const b = mine(2, 'row b');
    const c = mine(3, 'row c');
    stubApi({ pages: { [GEN]: { messages: [a, b, c], hasMore: false } } });
    const ws = await boot();
    const rowOf = (t: string) => within(log()).getByText(t).closest('li')!;
    await within(log()).findByText('row c');
    await userEvent.click(within(rowOf('row b')).getByRole('button', { name: 'Delete' }));
    expect(rowOf('row c').contains(document.activeElement)).toBe(true);
    act(() => ws.receive({ t: 'message.delete', message: tomb(b) }));
    await userEvent.click(within(rowOf('row c')).getByRole('button', { name: 'Delete' }));
    expect(rowOf('row a').contains(document.activeElement)).toBe(true);
    act(() => ws.receive({ t: 'message.delete', message: tomb(c) }));
    await userEvent.click(within(rowOf('row a')).getByRole('button', { name: 'Delete' }));
    expect(document.activeElement).toBe(log());
    act(() => ws.receive({ t: 'message.delete', message: tomb(a) }));
    expect(document.activeElement).toBe(log());
  });

  it('after a confirmed dialog delete focus lands on a neighbour, not the vanished button', async () => {
    const starter = mine(2, 'starter', { replyCount: 1 });
    stubApi({ pages: { [GEN]: { messages: [msg(1, { body: 'before' }), starter, msg(3, { body: 'after' })], hasMore: false } } });
    const ws = await boot();
    const row = (await within(log()).findByText('starter')).closest('li')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Delete' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    const after = within(log()).getByText('after').closest('li')!;
    expect(after.contains(document.activeElement)).toBe(true);
    act(() => ws.receive({ t: 'message.delete', message: tomb(starter) }));
    expect(after.contains(document.activeElement)).toBe(true);
  });

  it('cancelling still returns focus to the opener', async () => {
    const starter = mine(1, 'starter', { replyCount: 1 });
    stubApi({ pages: { [GEN]: { messages: [starter, msg(2, { body: 'after' })], hasMore: false } } });
    await boot();
    const del = within((await within(log()).findByText('starter')).closest('li')!).getByRole('button', { name: 'Delete' });
    await userEvent.click(del);
    await userEvent.keyboard('{Escape}');
    expect(document.activeElement).toBe(del);
  });

  it('in the thread panel focus stays inside the panel after a reply is deleted', async () => {
    vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    const starter = msg(1, { body: 'tp starter', replyCount: 2 });
    const r1 = mine(2, 'tp one', { parentId: starter.id });
    const r2 = mine(3, 'tp two', { parentId: starter.id });
    stubApi({
      pages: { [GEN]: { messages: [starter], hasMore: false } },
      route: (url) => (url === `/messages/${starter.id}/thread` ? { parent: starter, replies: [r1, r2] } : undefined),
    });
    const ws = await boot();
    await userEvent.click(await screen.findByRole('button', { name: '2 replies' }));
    const panel = await screen.findByRole('complementary', { name: 'Thread' });
    await within(panel).findByText('tp two');
    const rowOf = (t: string) => within(panel).getByText(t).closest('li')!;
    await userEvent.click(within(rowOf('tp one')).getByRole('button', { name: 'Delete' }));
    expect(rowOf('tp two').contains(document.activeElement)).toBe(true);
    act(() => ws.receive({ t: 'message.delete', message: tomb(r1) }));
    await userEvent.click(within(rowOf('tp two')).getByRole('button', { name: 'Delete' }));
    expect(panel.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(within(panel).getByPlaceholderText('Reply…'));
  });

  it('deleting the starter from the thread panel moves focus to the channel log', async () => {
    const starter = mine(1, 'my starter', { replyCount: 1 });
    const r1 = msg(2, { body: 'tp one', parentId: starter.id });
    stubApi({
      pages: { [GEN]: { messages: [starter], hasMore: false } },
      route: (url) => (url === `/messages/${starter.id}/thread` ? { parent: starter, replies: [r1] } : undefined),
    });
    const ws = await boot();
    await userEvent.click(await screen.findByRole('button', { name: '1 reply' }));
    const panel = await screen.findByRole('complementary', { name: 'Thread' });
    await within(panel).findByText('tp one');
    const parentRow = within(panel).getByText('my starter').closest('li')!;
    await userEvent.click(within(parentRow).getByRole('button', { name: 'Delete' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    act(() => ws.receive({ t: 'message.delete', message: tomb(starter) }));
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Thread' })).toBeNull());
    expect(document.activeElement).toBe(log());
  });

  it('the dialog count is frozen when it opens', async () => {
    const starter = mine(1, 'starter', { replyCount: 2 });
    stubApi({ pages: { [GEN]: { messages: [starter], hasMore: false } } });
    const ws = await boot();
    await userEvent.click(within((await within(log()).findByText('starter')).closest('li')!).getByRole('button', { name: 'Delete' }));
    const dlg = await screen.findByRole('dialog');
    act(() => ws.receive({ t: 'thread.counts', channelId: GEN, parentId: starter.id, replyCount: 0, lastReplyAt: null }));
    expect(dlg.textContent).toContain("This also deletes 2 replies.");
    expect(dlg.textContent).not.toContain('0 replies');
  });

  async function searchJump(hitMsg: Message, route: (u: string) => unknown, pages: Message[]) {
    stubApi({
      pages: { [GEN]: { messages: pages, hasMore: false } },
      route: (url) =>
        url.startsWith('/w/clubhack/search')
          ? { results: [{ message: hitMsg, channel: { id: GEN, name: 'general', kind: 'public', isMember: true }, snippet: [{ text: 'stale hit', hit: true }] }], nextCursor: null }
          : (route(url) as undefined),
    });
    const ws = await boot();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search messages' }), 'stale{Enter}');
    await userEvent.click(await screen.findByText('stale hit'));
    return ws;
  }

  it('jumping to a deleted thread reply says it was deleted', async () => {
    const starter = msg(1, { body: 's', replyCount: 1 });
    const dead = msg(2, { parentId: starter.id, deletedAt: 5, body: '' });
    const live = msg(3, { parentId: starter.id, body: 'live reply' });
    await searchJump(dead, (u) => (u === `/messages/${starter.id}/thread` ? { parent: starter, replies: [dead, live] } : undefined), [starter]);
    expect((await screen.findByRole('alert')).textContent).toBe('That message was deleted.');
  });

  it('jumping to a thread reply that is gone from the page says it was deleted', async () => {
    const starter = msg(1, { body: 's', replyCount: 1 });
    const gone = msg(2, { parentId: starter.id, body: 'x' });
    await searchJump(gone, (u) => (u === `/messages/${starter.id}/thread` ? { parent: starter, replies: [] } : undefined), [starter]);
    expect((await screen.findByRole('alert')).textContent).toBe('That message was deleted.');
  });

  it('jumping to an also-in-channel reply dropped by a starter cascade says deleted, not "too far back"', async () => {
    const starter = msg(1, { body: 's', deletedAt: 5 });
    const reply = msg(2, { parentId: starter.id, alsoInChannel: true, body: 'x' });
    await searchJump(reply, () => undefined, [starter, msg(3, { body: 'live' })]);
    expect((await screen.findByRole('alert')).textContent).toBe('That message was deleted.');
  });
});
