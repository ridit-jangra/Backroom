import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HubSocket, backoffDelay, wsUrl, type SocketState } from '../src/realtime/socket';
import { FakeWebSocket } from './fakeSocket';

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.reset();
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function inst(i: number): FakeWebSocket {
  const w = FakeWebSocket.instances[i];
  if (!w) throw new Error('no socket ' + i);
  return w;
}

function make(probe: () => Promise<boolean> = async () => true) {
  const states: SocketState[] = [];
  const frames: unknown[] = [];
  const o = {
    onOpen: vi.fn(),
    onAuthLost: vi.fn(),
    probeAuth: vi.fn(probe),
  };
  const s = new HubSocket({
    url: 'ws://x/ws',
    onFrame: (f) => frames.push(f),
    onState: (st) => states.push(st),
    random: () => 0.5,
    ...o,
  });
  return { s, states, frames, ...o };
}

describe('backoff', () => {
  it('backoff grows to 30 s with jitter', () => {
    expect(backoffDelay(0, 0)).toBe(500);
    expect(backoffDelay(0, 1)).toBe(1000);
    expect(backoffDelay(10, 1)).toBe(30000);
    expect(backoffDelay(10, 0)).toBe(15000);
  });
  it('wsUrl encodes the slug', () => {
    expect(wsUrl('a b')).toBe(`ws://${location.host}/ws?workspace=a%20b`);
  });
});

describe('HubSocket', () => {
  it('reconnects with backoff and calls onOpen each time', () => {
    const { s, states, onOpen } = make();
    s.start();
    inst(0).open();
    expect(onOpen).toHaveBeenCalledTimes(1);
    inst(0).serverClose(1006);
    expect(states.at(-1)).toBe('reconnecting');
    vi.advanceTimersByTime(backoffDelay(0, 0.5) - 1);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
    inst(1).open();
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(states.at(-1)).toBe('open');
  });

  it('error followed by close schedules a single reconnect', () => {
    const { s } = make();
    s.start();
    const ws = inst(0);
    ws.onerror?.();
    ws.serverClose(1006);
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('close code 4001 calls onAuthLost and stops', () => {
    const { s, onAuthLost } = make();
    s.start();
    inst(0).open();
    inst(0).serverClose(4001);
    expect(onAuthLost).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(120_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('second failed attempt probes auth; false calls onAuthLost', async () => {
    const { s, onAuthLost, probeAuth } = make(async () => false);
    s.start();
    inst(0).serverClose(1006);
    expect(probeAuth).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    inst(1).serverClose(1006);
    expect(probeAuth).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(onAuthLost).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(120_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('probe returning true keeps reconnecting', async () => {
    const { s, onAuthLost } = make(async () => true);
    s.start();
    inst(0).serverClose(1006);
    vi.advanceTimersByTime(1000);
    inst(1).serverClose(1006);
    await vi.advanceTimersByTimeAsync(5000);
    expect(onAuthLost).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it('missing pong forces reconnect', () => {
    const { s, states } = make();
    s.start();
    const ws = inst(0);
    ws.open();
    vi.advanceTimersByTime(30_000);
    expect(ws.sent.at(-1)).toBe('{"t":"ping"}');
    vi.advanceTimersByTime(10_000);
    expect(ws.closeCalled).toBe(true);
    expect(states.at(-1)).toBe('reconnecting');
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('pong keeps the connection; frames are parsed and bad ones dropped', () => {
    const { s, frames } = make();
    s.start();
    const ws = inst(0);
    ws.open();
    vi.advanceTimersByTime(30_000);
    ws.receive({ t: 'pong' });
    ws.receive('not json');
    ws.receive({ t: 'nope' });
    ws.receive({ t: 'stale', channelId: 'c' });
    vi.advanceTimersByTime(10_000);
    expect(ws.closeCalled).toBe(false);
    expect(frames).toEqual([{ t: 'stale', channelId: 'c' }]);
  });

  it('send returns false when not open and true when open; stop closes', () => {
    const { s, states } = make();
    s.start();
    expect(s.send({ t: 'activity' })).toBe(false);
    const ws = inst(0);
    ws.open();
    expect(s.send({ t: 'activity' })).toBe(true);
    expect(ws.sent).toEqual(['{"t":"activity"}']);
    s.stop();
    expect(states.at(-1)).toBe('closed');
    vi.advanceTimersByTime(120_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
