import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Message } from '@backroom/protocol';
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
    await waitFor(() => expect(within(log()).queryByText('will be deleted')).toBeNull());
    expect(within(log()).queryByText('starter text')).toBeNull();
    expect(within(log()).queryByText('also text')).toBeNull();
    expect(within(log()).getByText('survivor')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Thread' })).toBeNull());
    expect(screen.queryByText(/was deleted/i)).toBeNull();
  });

  it('the first connect does not refetch the open channel again; a reconnect does, once', async () => {
    const counts = { n: 0 };
    stubApi({
      route: (url) => {
        if (url.startsWith(`/channels/${GEN}/messages`)) counts.n++;
        return undefined;
      },
    });
    const ws = await boot();
    await waitFor(() => expect(counts.n).toBeGreaterThanOrEqual(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(counts.n).toBe(1);
    act(() => ws.serverClose(1006));
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(2), { timeout: 3000 });
    act(() => FakeWebSocket.instances[1]!.open());
    await waitFor(() => expect(counts.n).toBe(2));
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
