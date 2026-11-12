import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CustomEmoji } from '@backroom/protocol';
import { FakeWebSocket } from './fakeSocket';
import { BOB, GEN, ME, boot, frames, makeBootstrap, msg, stubApi } from './harness';
import { reactionTooltip } from '../src/emoji/ReactionBar';

beforeEach(() => {
  FakeWebSocket.reset();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  history.replaceState(null, '', '/');
});

const pid = '01JPARROT'.padEnd(26, '0');
const partyparrot: CustomEmoji = { id: pid, name: 'partyparrot', url: `/emoji/${pid}`, aliasFor: null, createdBy: ME, createdAt: 1 };
const pp: CustomEmoji = { id: '01JPP'.padEnd(26, '0'), name: 'pp', url: null, aliasFor: 'partyparrot', createdBy: ME, createdAt: 2 };

async function setup(messages: ReturnType<typeof msg>[], customEmoji: CustomEmoji[] = [], ready = messages[0]!.body) {
  stubApi({
    bootstrap: () => ({ ...makeBootstrap(), customEmoji }),
    pages: { [GEN]: { messages, hasMore: false } },
  });
  const ws = await boot();
  await screen.findByRole('log').then(() => vi.waitFor(() => expect(document.querySelector('.msg-body')?.textContent).toContain(ready)));
  return ws;
}
const lastFrame = (ws: FakeWebSocket) => frames(ws).at(-1)!;

describe('reactionTooltip', () => {
  const members = [
    { id: ME, displayName: 'Me', role: 'member' as const, avatarKey: null },
    { id: BOB, displayName: 'Bob', role: 'member' as const, avatarKey: null },
    { id: 'A', displayName: 'Ann', role: 'member' as const, avatarKey: null },
  ];
  it('puts You first, joins names, and caps at 10', () => {
    expect(reactionTooltip([ME], ME, members, '+1')).toBe('You reacted with :+1:');
    expect(reactionTooltip([BOB, ME, 'A'], ME, members, 'tada')).toBe('You, Bob and Ann reacted with :tada:');
    expect(reactionTooltip(['X'], ME, members, 'x')).toBe('Unknown reacted with :x:');
    const many = Array.from({ length: 13 }, (_, i) => `U${i}`);
    expect(reactionTooltip(many, ME, [], 'x')).toBe(
      'Unknown, Unknown, Unknown, Unknown, Unknown, Unknown, Unknown, Unknown, Unknown, Unknown and 3 others reacted with :x:',
    );
  });
});

describe('reactions', () => {
  it('pills show count, pressed state and names', async () => {
    await setup([msg(1, { reactions: [{ emoji: '+1', userIds: [ME, BOB] }] })]);
    const pill = await screen.findByRole('button', { name: 'You and Bob reacted with :+1:' });
    expect(pill.getAttribute('aria-pressed')).toBe('true');
    expect(pill.getAttribute('title')).toBe('You and Bob reacted with :+1:');
    expect(pill.textContent).toContain('2');
    expect(pill.querySelector('img')).not.toBeNull();
  });

  it("clicking my pill sends on:false; another's sends on:true", async () => {
    const m = msg(1, { reactions: [{ emoji: '+1', userIds: [ME, BOB] }, { emoji: 'tada', userIds: [BOB] }] });
    const ws = await setup([m]);
    await userEvent.click(await screen.findByRole('button', { name: /You and Bob reacted/ }));
    expect(lastFrame(ws)).toMatchObject({ t: 'react', messageId: m.id, emoji: '+1', on: false });
    await userEvent.click(screen.getByRole('button', { name: 'Bob reacted with :tada:' }));
    expect(lastFrame(ws)).toMatchObject({ t: 'react', messageId: m.id, emoji: 'tada', on: true });
  });

  it('Add reaction opens the picker and sends the picked code', async () => {
    const m = msg(1);
    const ws = await setup([m]);
    await userEvent.click(await screen.findByRole('button', { name: 'Add reaction' }));
    const dialog = screen.getByRole('dialog', { name: 'Add reaction' });
    await userEvent.type(within(dialog).getByLabelText('Search emoji'), 'fire');
    await userEvent.click(within(dialog).getByRole('button', { name: ':fire:' }));
    expect(lastFrame(ws)).toMatchObject({ t: 'react', messageId: m.id, emoji: 'fire', on: true });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('picking an alias of an emoji I already reacted with toggles it off (P3-R9)', async () => {
    const m = msg(1, { reactions: [{ emoji: 'partyparrot', userIds: [ME] }] });
    const ws = await setup([m], [partyparrot, pp]);
    await userEvent.click(await screen.findByRole('button', { name: 'Add reaction' }));
    const dialog = screen.getByRole('dialog', { name: 'Add reaction' });
    await userEvent.type(within(dialog).getByLabelText('Search emoji'), 'pp');
    await userEvent.click(within(dialog).getByRole('button', { name: ':pp:' }));
    expect(lastFrame(ws)).toMatchObject({ t: 'react', emoji: 'partyparrot', on: false });
  });

  it('picking a built-in alias of a reacted emoji toggles it off', async () => {
    const m = msg(1, { reactions: [{ emoji: '+1', userIds: [ME] }] });
    const ws = await setup([m]);
    await userEvent.click(await screen.findByRole('button', { name: 'Add reaction' }));
    const dialog = screen.getByRole('dialog', { name: 'Add reaction' });
    await userEvent.type(within(dialog).getByLabelText('Search emoji'), '+1');
    await userEvent.click(within(dialog).getAllByRole('button', { name: ':+1:' })[0]!);
    expect(lastFrame(ws)).toMatchObject({ t: 'react', emoji: '+1', on: false });
  });

  it('a live reaction frame adds a pill; off removes it', async () => {
    const m = msg(1);
    const ws = await setup([m]);
    expect(document.querySelector('.reaction')).toBeNull();
    act(() => ws.receive({ t: 'reaction', channelId: GEN, messageId: m.id, emoji: 'tada', userId: BOB, on: true }));
    expect(await screen.findByRole('button', { name: 'Bob reacted with :tada:' })).toBeTruthy();
    act(() => ws.receive({ t: 'reaction', channelId: GEN, messageId: m.id, emoji: 'tada', userId: BOB, on: false }));
    expect(document.querySelector('.reaction')).toBeNull();
  });

  it('reaction controls are disabled while reconnecting', async () => {
    const ws = await setup([msg(1, { reactions: [{ emoji: '+1', userIds: [BOB] }] })]);
    act(() => ws.serverClose(1006));
    expect((await screen.findByRole('button', { name: 'Bob reacted with :+1:' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Add reaction' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a deleted message shows no reactions', async () => {
    stubApi({ pages: { [GEN]: { messages: [msg(1, { deletedAt: 1_700_000_009_000, reactions: [{ emoji: '+1', userIds: [BOB] }] })], hasMore: false } } });
    await boot();
    await screen.findByText('This message was deleted.');
    expect(document.querySelector('.reaction')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add reaction' })).toBeNull();
  });

  it('deleting a custom emoji turns its uses into :name: text live', async () => {
    const ws = await setup([msg(1, { body: 'look :partyparrot:', reactions: [{ emoji: 'partyparrot', userIds: [BOB] }] })], [partyparrot], 'look');
    await vi.waitFor(() => expect(document.querySelectorAll(`img[src="/emoji/${pid}"]`)).toHaveLength(2));
    act(() => ws.receive({ t: 'emoji.update', added: [], removed: [pid] }));
    // emoji.update frames are coalesced for a moment before they apply.
    await vi.waitFor(() => expect(document.querySelector('img[src^="/emoji/"]')).toBeNull());
    expect(document.querySelector('.msg-body')!.textContent).toBe('look :partyparrot:');
    expect(document.querySelector('.reaction')!.textContent).toContain(':partyparrot:');
  });

  it('thread messages carry reactions too', async () => {
    const parent = msg(1, { body: 'parent text', replyCount: 1, lastReplyAt: 1_700_000_005_000, reactions: [{ emoji: 'tada', userIds: [BOB] }] });
    const reply = msg(2, { parentId: parent.id, body: 'a reply' });
    const ws = await (async () => {
      stubApi({
        pages: { [GEN]: { messages: [parent], hasMore: false } },
        route: (url) => (url === `/messages/${parent.id}/thread` ? { parent, replies: [reply] } : undefined),
      });
      return boot();
    })();
    await userEvent.click(await screen.findByRole('button', { name: '1 reply' }));
    const panel = await screen.findByRole('complementary', { name: 'Thread' });
    await userEvent.click(await within(panel).findByRole('button', { name: 'Bob reacted with :tada:' }));
    expect(lastFrame(ws)).toMatchObject({ t: 'react', messageId: parent.id, emoji: 'tada', on: true });
    expect(within(panel).getAllByRole('button', { name: 'Add reaction' })).toHaveLength(2);
  });

  it('an archived channel shows existing reactions as disabled pills, with no Add reaction', async () => {
    const RAND = '01JRANDOM'.padEnd(26, '0');
    stubApi({ pages: { [RAND]: { messages: [msg(1, { channelId: RAND, body: 'old talk', reactions: [{ emoji: '+1', userIds: [BOB] }] })], hasMore: false } } });
    const ws = await boot(`/client/clubhack/${RAND}`);
    await screen.findByText('old talk');
    act(() => ws.receive({ t: 'channel.update', channel: { id: RAND, name: 'random', kind: 'public', topic: null, archivedAt: 9 } }));
    await screen.findByText('This channel is archived.');
    const pill = screen.getByRole('button', { name: 'Bob reacted with :+1:' }) as HTMLButtonElement;
    expect(pill.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Add reaction' })).toBeNull();
  });

  it('a pill toggle that cannot be sent shows the inline error', async () => {
    const ws = await setup([msg(1, { reactions: [{ emoji: '+1', userIds: [BOB] }] })]);
    ws.readyState = 3;
    // Not connected state flows from the socket layer; a failed send reports false.
    await userEvent.click(await screen.findByRole('button', { name: 'Bob reacted with :+1:' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('an open picker closes when the connection drops and stays closed after reconnect', async () => {
    const ws = await setup([msg(1)]);
    await userEvent.click(await screen.findByRole('button', { name: 'Add reaction' }));
    expect(screen.getByRole('dialog', { name: 'Add reaction' })).toBeTruthy();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    act(() => ws.serverClose(1006));
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(FakeWebSocket.instances).toHaveLength(1);
    // backoffDelay(0, r) is at most 1 s: the socket reconnects with a new instance.
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(FakeWebSocket.instances).toHaveLength(2);
    const next = FakeWebSocket.instances[1]!;
    act(() => next.open());
    expect(frames(next)[0]).toMatchObject({ t: 'hello' });
    await vi.waitFor(() => expect((screen.getByRole('button', { name: 'Add reaction' }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('wave and wave::skin-tone-3 are distinct pills that toggle independently', async () => {
    const m = msg(1, { reactions: [{ emoji: 'wave', userIds: [ME] }, { emoji: 'wave::skin-tone-3', userIds: [BOB] }] });
    const ws = await setup([m]);
    const plain = await screen.findByRole('button', { name: 'You reacted with :wave:' });
    const toned = screen.getByRole('button', { name: 'Bob reacted with :wave::skin-tone-3:' });
    expect(plain.getAttribute('aria-pressed')).toBe('true');
    expect(toned.getAttribute('aria-pressed')).toBe('false');
    await userEvent.click(toned);
    expect(lastFrame(ws)).toMatchObject({ emoji: 'wave::skin-tone-3', on: true });
    await userEvent.click(plain);
    expect(lastFrame(ws)).toMatchObject({ emoji: 'wave', on: false });
  });

  it('picking a custom alias records its canonical target as frequent', async () => {
    await setup([msg(1)], [partyparrot, pp]);
    await userEvent.click(await screen.findByRole('button', { name: 'Add reaction' }));
    const dialog = screen.getByRole('dialog', { name: 'Add reaction' });
    await userEvent.type(within(dialog).getByLabelText('Search emoji'), 'pp');
    await userEvent.click(within(dialog).getByRole('button', { name: ':pp:' }));
    const uses = Object.keys(JSON.parse(localStorage.getItem(`backroom:emoji:${ME}`)!).uses);
    expect(uses).toEqual(['partyparrot']);
  });
});
