import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { Message } from '@backroom/protocol';
import { useChat, type ChatActions } from '../src/realtime/useChat';
import type { ChatState } from '../src/state/chat';
import { FakeWebSocket } from './fakeSocket';
import { GEN, RAND, msg, stubApi, type Route } from './harness';

beforeEach(() => {
  FakeWebSocket.reset();
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ALL: Message[] = Array.from({ length: 300 }, (_, i) => msg(i + 1));

let api: { state: ChatState; actions: ChatActions } | null = null;
function Probe() {
  const { state, actions } = useChat('clubhack');
  api = { state, actions };
  return null;
}
async function mount(route?: Route, pages: Record<string, Message[] | { messages: Message[]; hasMore: boolean }> = { [GEN]: ALL }) {
  stubApi({ pages, route });
  render(<Probe />);
  await waitFor(() => expect(api!.state.bootstrap).not.toBeNull());
}
const historyCalls = (cid: string) =>
  vi.mocked(fetch as unknown as (u: string) => unknown).mock.calls.filter(([u]) => String(u).startsWith(`/channels/${cid}/messages?`));
const target = (seq: number) => ({ channelId: GEN, messageId: ALL[seq - 1]!.id, seq, parentId: null, alsoInChannel: false });

describe('jumpTo', () => {
  it('loads older pages until the message is present and highlights it', async () => {
    await mount();
    let ok: boolean | 'deleted' = false;
    await act(async () => {
      ok = await api!.actions.jumpTo(target(120));
    });
    expect(ok).toBe(true);
    expect(historyCalls(GEN)).toHaveLength(4);
    expect(api!.state.highlightId).toBe(ALL[119]!.id);
    expect(api!.state.openChannelId).toBe(GEN);
  });

  it('a thread reply opens the thread and highlights it', async () => {
    const parent = msg(1, { replyCount: 1 });
    const reply = msg(2, { parentId: parent.id });
    await mount((url) => (url === `/messages/${parent.id}/thread` ? { parent, replies: [reply] } : undefined), {
      [GEN]: { messages: [parent], hasMore: false },
    });
    let ok: boolean | 'deleted' = false;
    await act(async () => {
      ok = await api!.actions.jumpTo({ channelId: GEN, messageId: reply.id, seq: 2, parentId: parent.id, alsoInChannel: false });
    });
    expect(ok).toBe(true);
    expect(api!.state.openThreadId).toBe(parent.id);
    expect(api!.state.highlightId).toBe(reply.id);
    await waitFor(() => expect(vi.mocked(fetch as unknown as (u: string) => unknown).mock.calls.some(([u]) => u === `/messages/${parent.id}/thread`)).toBe(true));
  });

  it('gives up after 20 older pages', async () => {
    const many = Array.from({ length: 1500 }, (_, i) => msg(i + 1));
    await mount(undefined, { [GEN]: many });
    let ok: boolean | 'deleted' = true;
    await act(async () => {
      ok = await api!.actions.jumpTo({ channelId: GEN, messageId: many[0]!.id, seq: 1, parentId: null, alsoInChannel: false });
    });
    expect(ok).toBe(false);
    expect(historyCalls(GEN)).toHaveLength(21);
    expect(api!.state.highlightId).toBeNull();
  });

  it('jumping to a channel that is not open loads the latest page once and keeps the highlight', async () => {
    const rand = Array.from({ length: 10 }, (_, i) => msg(i + 1, { channelId: RAND }));
    await mount(undefined, { [GEN]: ALL, [RAND]: rand });
    let ok: boolean | 'deleted' = false;
    await act(async () => {
      ok = await api!.actions.jumpTo({ channelId: RAND, messageId: rand[3]!.id, seq: 4, parentId: null, alsoInChannel: false });
    });
    expect(ok).toBe(true);
    expect(historyCalls(RAND)).toHaveLength(1);
    expect(api!.state.highlightId).toBe(rand[3]!.id);
  });

  it('waits for an in-flight older load instead of giving up', async () => {
    await mount();
    await act(async () => {
      await api!.actions.jumpTo(target(290));
    });
    let ok: boolean | 'deleted' = false;
    await act(async () => {
      const scroll = api!.actions.loadOlder(GEN);
      ok = await api!.actions.jumpTo(target(120));
      await scroll;
    });
    expect(ok).toBe(true);
  });

  it('returns false and does not highlight when the channel changes mid-jump', async () => {
    await mount();
    let ok: boolean | 'deleted' = true;
    await act(async () => {
      const p = api!.actions.jumpTo(target(120));
      api!.actions.open(RAND);
      ok = await p;
    });
    expect(ok).toBe(false);
    expect(api!.state.highlightId).toBeNull();
  });

  it('re-jumping to the same message re-triggers the highlight', async () => {
    await mount();
    await act(async () => {
      await api!.actions.jumpTo(target(290));
    });
    const n = api!.state.highlightNonce;
    await act(async () => {
      await api!.actions.jumpTo(target(290));
    });
    expect(api!.state.highlightNonce).toBe(n + 1);
  });
});
