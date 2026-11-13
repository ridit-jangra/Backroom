import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { Bootstrap, CustomEmoji } from '@backroom/protocol';
import { Composer } from '../src/components/Composer';
import { EmojiImg } from '../src/emoji/EmojiImg';
import { ReactionBar } from '../src/emoji/ReactionBar';
import { EMOJI_COALESCE_MS, useChat } from '../src/realtime/useChat';
import type { ChatState } from '../src/state/chat';
import { FakeWebSocket } from './fakeSocket';
import { BOB, ME, boot, makeBootstrap, stubApi } from './harness';

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

const ce = (n: number): CustomEmoji => {
  const eid = `01JCE${n}`.padEnd(26, '0');
  return { id: eid, name: `ce${n}`, url: `/emoji/${eid}`, aliasFor: null, createdBy: ME, createdAt: n };
};
const bootstrapUrls = () =>
  vi
    .mocked(fetch)
    .mock.calls.map(([u]) => String(u))
    .filter((u) => /\/bootstrap(\?|$)/.test(u));

describe('emojiRev bootstrap (P3-R20)', () => {
  it('first load sends no rev; reconnect sends the held rev and keeps the list when it is omitted', async () => {
    const parrot = ce(1);
    let calls = 0;
    stubApi({
      route: (url) => {
        if (!/\/bootstrap(\?|$)/.test(url)) return undefined;
        calls++;
        // The server omits customEmoji when the client's rev matches.
        const b: Bootstrap = { ...makeBootstrap(), emojiRev: 7 };
        return url.endsWith('?emojiRev=7') ? b : { ...b, customEmoji: [parrot] };
      },
    });
    const ws = await boot();
    await waitFor(() => expect(calls).toBe(2)); // startup + onOpen
    const urls = bootstrapUrls();
    expect(urls[0]).toBe('/w/clubhack/bootstrap');
    expect(urls[1]).toBe('/w/clubhack/bootstrap?emojiRev=7');

    vi.useFakeTimers({ shouldAdvanceTime: true });
    act(() => ws.serverClose(1006));
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(FakeWebSocket.instances).toHaveLength(2);
    act(() => FakeWebSocket.instances[1]!.open());
    await waitFor(() => expect(calls).toBe(3));
    expect(bootstrapUrls()[2]).toBe('/w/clubhack/bootstrap?emojiRev=7');

    // The held list still renders :ce1: as an image.
    act(() =>
      FakeWebSocket.instances[1]!.receive({
        t: 'message.new',
        message: { id: '01JMSGX'.padEnd(26, '0'), channelId: '01JGENERAL'.padEnd(26, '0'), seq: 1, userId: BOB, parentId: null, body: 'hi :ce1:', alsoInChannel: false, createdAt: 1, editedAt: null, deletedAt: null, replyCount: 0, lastReplyAt: null },
      }),
    );
    await waitFor(() => expect(document.querySelector(`img[src="/emoji/${parrot.id}"]`)).not.toBeNull());
  });
});

describe('emoji.update coalescing', () => {
  it('N rapid emoji.update frames cause one state change', async () => {
    stubApi();
    const seen: Record<string, CustomEmoji>[] = [];
    const { result } = renderHook(() => {
      const r = useChat('clubhack');
      if (seen.at(-1) !== r.state.customEmoji) seen.push(r.state.customEmoji);
      return r;
    });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.open());
    await waitFor(() => expect(result.current.state.bootstrap).not.toBeNull());
    await waitFor(() => expect(bootstrapUrls()).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 20));
    const before = seen.length;

    const N = 25;
    act(() => {
      for (let i = 0; i < N; i++) ws.receive({ t: 'emoji.update', added: [ce(i)], removed: [] });
    });
    expect(Object.keys(result.current.state.customEmoji)).toHaveLength(0);
    await act(() => new Promise((r) => setTimeout(r, EMOJI_COALESCE_MS + 30)));
    expect(Object.keys(result.current.state.customEmoji)).toHaveLength(N);
    expect(seen.length - before).toBe(1);
  });

  it('queued frames apply in order before the next other event (add then remove)', async () => {
    stubApi();
    const { result } = renderHook(() => useChat('clubhack'));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.open());
    await waitFor(() => expect(result.current.state.bootstrap).not.toBeNull());
    const e = ce(1);
    act(() => {
      ws.receive({ t: 'emoji.update', added: [e], removed: [] });
      ws.receive({ t: 'emoji.update', added: [], removed: [e.id] });
      ws.receive({ t: 'presence', userId: BOB, state: 'active' });
    });
    // The presence frame flushed the queue synchronously, in arrival order.
    expect(result.current.state.customEmoji).toEqual({});
    expect(result.current.state.presence[BOB]).toBe('active');
  });
});

describe('ReactionBar with a deleted emoji', () => {
  it('disables a pill whose code no longer resolves unless it is mine', () => {
    const onToggle = vi.fn(() => true);
    render(
      <ReactionBar
        reactions={[
          { emoji: 'goneparrot', userIds: [BOB] },
          { emoji: 'mygone', userIds: [ME] },
          { emoji: '+1', userIds: [BOB] },
        ]}
        me={ME}
        members={[]}
        connected
        onToggle={onToggle}
      />,
    );
    const [gone, mine, ok] = screen.getAllByRole('button') as HTMLButtonElement[];
    expect(gone!.disabled).toBe(true);
    expect(gone!.title).toBe('This emoji was deleted');
    expect(mine!.disabled).toBe(false);
    expect(ok!.disabled).toBe(false);
    expect(ok!.title).toBe('Unknown reacted with :+1:');
    fireEvent.click(mine!);
    expect(onToggle).toHaveBeenCalledWith('mygone', false);
  });
});

describe('EmojiImg fallback', () => {
  it('swaps to alt text when the image fails to load', () => {
    const { container } = render(
      <p>
        <EmojiImg e={{ src: '/twemoji/ffff.svg', alt: '🫨', title: ':shaking:' }} />
        <EmojiImg e={{ src: '/emoji/01JGONE000000000000000000', alt: ':gone:', title: ':gone:' }} />
      </p>,
    );
    const imgs = container.querySelectorAll('img');
    expect(imgs).toHaveLength(2);
    fireEvent.error(imgs[0]!);
    fireEvent.error(imgs[1]!);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('🫨:gone:');
  });
});

describe('composer emoji button layout', () => {
  it('anchors the button to a wrapper with the textarea; the too-long alert sits outside it', () => {
    render(<Composer placeholder="Message" members={[]} onSubmit={() => {}} />);
    const ta = screen.getByLabelText('Message') as HTMLTextAreaElement;
    const btn = screen.getByRole('button', { name: 'Emoji' });
    const wrap = btn.parentElement!;
    expect(wrap.className).toBe('composer-input');
    expect(ta.parentElement).toBe(wrap);
    fireEvent.change(ta, { target: { value: 'x'.repeat(40_001), selectionStart: 40_001 } });
    const alert = screen.getByRole('alert');
    expect(wrap.contains(alert)).toBe(false);
    const css = readFileSync(`${import.meta.dirname}/../src/styles.css`, 'utf8');
    expect(css).toMatch(/\.composer-input \{ position: relative; \}/);
    expect(css).toMatch(/\.composer textarea \{[^}]*padding: 0\.375rem 2\.25rem 0\.25rem 0;/);
  });
});
