import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Composer } from '../src/components/Composer';
import { MEMBER_REFRESH_MS } from '../src/realtime/useChat';
import { FakeWebSocket } from './fakeSocket';
import { BOB, GEN, RAND, boot, chan, frames, id, makeBootstrap, msg, stubApi } from './harness';

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

const ZED = id('01JZED');
const zed = { id: ZED, displayName: 'Zed', role: 'member' as const, avatarKey: null, deactivated: true as const };
const fetched = (pred: (u: string) => boolean) => vi.mocked(fetch).mock.calls.filter(([u]) => pred(String(u))).length;
const log = () => screen.getByRole('log', { name: 'Messages' });

describe('stale refetch (open channel and thread)', () => {
  const parent = msg(1, { body: 'parent text', replyCount: 1 });
  const reply = msg(2, { parentId: parent.id, body: 'only reply' });
  const isHistory = (u: string) => u.startsWith(`/channels/${GEN}/messages?`);
  const isThread = (u: string) => u === `/messages/${parent.id}/thread`;

  it('stale for the open channel refetches its history', async () => {
    stubApi({ pages: { [GEN]: { messages: [parent], hasMore: false } } });
    const ws = await boot();
    await within(log()).findByText('parent text');
    await waitFor(() => expect(fetched(isHistory)).toBeGreaterThan(0));
    const before = fetched(isHistory);
    act(() => ws.receive({ t: 'stale', channelId: GEN }));
    await waitFor(() => expect(fetched(isHistory)).toBe(before + 1));
    expect(await within(log()).findByText('parent text')).toBeTruthy();
  });

  it('stale for the open thread\'s channel refetches the thread (no stuck Loading…)', async () => {
    stubApi({
      pages: { [GEN]: { messages: [parent], hasMore: false } },
      route: (url) => (isThread(url) ? { parent, replies: [reply] } : undefined),
    });
    const ws = await boot();
    await userEvent.click(await screen.findByRole('button', { name: '1 reply' }));
    const panel = await screen.findByRole('complementary', { name: 'Thread' });
    await within(panel).findByText('only reply'); // the REST reply landed before the stale frame
    const before = fetched(isThread);
    act(() => ws.receive({ t: 'stale', channelId: GEN }));
    await waitFor(() => expect(fetched(isThread)).toBe(before + 1));
    expect(await within(panel).findByText('only reply')).toBeTruthy();
    expect(within(panel).queryByText('Loading…')).toBeNull();
  });

  it('stale for another channel leaves the open thread alone', async () => {
    stubApi({
      pages: { [GEN]: { messages: [parent], hasMore: false } },
      route: (url) => (isThread(url) ? { parent, replies: [reply] } : undefined),
    });
    const ws = await boot();
    await userEvent.click(await screen.findByRole('button', { name: '1 reply' }));
    const panel = await screen.findByRole('complementary', { name: 'Thread' });
    await within(panel).findByText('only reply');
    const before = fetched(isThread);
    act(() => ws.receive({ t: 'stale', channelId: RAND }));
    await new Promise((r) => setTimeout(r, 50));
    expect(fetched(isThread)).toBe(before);
  });
});

describe('deactivated and unknown members (P2-R28)', () => {
  it('shows a deactivated member\'s name on their messages, but not in the member list or New message', async () => {
    stubApi({
      bootstrap: () => makeBootstrap({ members: [...makeBootstrap().members, zed] }),
      pages: { [GEN]: { messages: [msg(1, { userId: ZED, body: 'old words' })], hasMore: false } },
    });
    await boot();
    const row = (await within(log()).findByText('old words')).closest('li')!;
    expect(within(row).getByText('Zed')).toBeTruthy();
    expect(within(row).queryByText('Unknown')).toBeNull();
    expect(within(screen.getByRole('list', { name: 'Members' })).queryByText('Zed')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'New message' }));
    const dlg = await screen.findByRole('dialog', { name: 'New message' });
    expect(within(dlg).getByText('Bob')).toBeTruthy();
    expect(within(dlg).queryByText('Zed')).toBeNull();
  });

  it('mention autocomplete leaves out deactivated members', () => {
    render(<Composer placeholder="Message" members={[{ id: BOB, displayName: 'Zebra', role: 'member', avatarKey: null }, zed]} onSubmit={() => {}} />);
    const ta = screen.getByLabelText('Message') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '@z', selectionStart: 2 } });
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]!.textContent).toContain('Zebra');
  });

  it('a frame from a user not in members refreshes bootstrap once per 10 s', async () => {
    const isBootstrap = (u: string) => u.endsWith('/bootstrap');
    stubApi();
    const ws = await boot();
    await screen.findByRole('button', { name: '#general' });
    await waitFor(() => expect(fetched(isBootstrap)).toBe(2)); // startup + after open
    await new Promise((r) => setTimeout(r, 20));
    const base = fetched(isBootstrap);

    // Known authors never refetch.
    act(() => ws.receive({ t: 'message.new', message: msg(1, { userId: BOB }) }));
    await new Promise((r) => setTimeout(r, 20));
    expect(fetched(isBootstrap)).toBe(base);

    act(() => ws.receive({ t: 'message.new', message: msg(2, { userId: id('01JNEW1') }) }));
    await waitFor(() => expect(fetched(isBootstrap)).toBe(base + 1));
    act(() => ws.receive({ t: 'typing', channelId: GEN, userId: id('01JNEW2') }));
    act(() => ws.receive({ t: 'message.new', message: msg(3, { userId: id('01JNEW3') }) }));
    await new Promise((r) => setTimeout(r, 20));
    expect(fetched(isBootstrap)).toBe(base + 1); // throttled

    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + MEMBER_REFRESH_MS + 1);
    act(() => ws.receive({ t: 'message.new', message: msg(4, { userId: id('01JNEW4') }) }));
    await waitFor(() => expect(fetched(isBootstrap)).toBe(base + 2));
  });
});

describe('mark_read throttle is per channel', () => {
  it('A → B → C within 1 s still sends mark_read for B', async () => {
    const C = id('01JTHIRD');
    stubApi({
      bootstrap: () =>
        makeBootstrap({
          channels: [
            chan(GEN, 'general', { lastSeq: 4, lastReadSeq: 2, unreadCount: 2 }),
            chan(RAND, 'random', { lastSeq: 7, lastReadSeq: 5, unreadCount: 2 }),
            chan(C, 'third', { lastSeq: 3, lastReadSeq: 1, unreadCount: 2 }),
          ],
        }),
    });
    const ws = await boot();
    await waitFor(() => expect(frames(ws)).toContainEqual({ t: 'mark_read', channelId: GEN, seq: 4 }));
    await userEvent.click(screen.getByRole('button', { name: '#random' }));
    await userEvent.click(screen.getByRole('button', { name: '#third' }));
    await waitFor(() => expect(frames(ws)).toContainEqual({ t: 'mark_read', channelId: C, seq: 3 }));
    expect(frames(ws)).toContainEqual({ t: 'mark_read', channelId: RAND, seq: 7 });
  });
});

describe('capped counts (P2-R27)', () => {
  it('a mention count above 99 renders as 99+', async () => {
    stubApi({
      bootstrap: () => makeBootstrap({ channels: [chan(GEN, 'general'), chan(RAND, 'random', { lastSeq: 150, unreadCount: 100, mentionCount: 100 })] }),
    });
    await boot();
    const badge = await screen.findByLabelText('99+ mentions');
    expect(badge.textContent).toBe('99+');
  });

  it('99 still renders as 99', async () => {
    stubApi({
      bootstrap: () => makeBootstrap({ channels: [chan(GEN, 'general'), chan(RAND, 'random', { lastSeq: 99, unreadCount: 99, mentionCount: 99 })] }),
    });
    await boot();
    expect((await screen.findByLabelText('99 mentions')).textContent).toBe('99');
  });
});

