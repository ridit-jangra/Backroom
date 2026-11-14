import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ATTACHMENT_MAX_BYTES,
  DurableObject,
  MAX_BUFFERED_BYTES,
  DurableObjectNamespaceShim,
  attachRawSocket,
  createWebSocketPair,
  type NodeDurableObjectState,
  type RawSocket,
} from '../src/platform/do-runtime';
import { DurableObject as ShimExport } from '../src/platform/cloudflare-workers-shim';

/** A stand-in for a `ws` connection: records what the shim sends and lets a test play the peer. */
class FakeRaw extends EventEmitter implements RawSocket {
  readyState = 1;
  /** Bytes queued but not yet written to the kernel (ws's bufferedAmount). */
  bufferedAmount = 0;
  sent: (string | ArrayBuffer | ArrayBufferView)[] = [];
  closes: { code?: number; reason?: string }[] = [];
  /** Delivered to the send callback (the socket died while the frame was queued). */
  sendError: Error | null = null;
  /** Thrown synchronously by send (ws throws on a socket that is not open yet). */
  sendThrows: Error | null = null;
  terminated = false;

  send(data: string | ArrayBuffer | ArrayBufferView, cb?: (err?: Error) => void): void {
    if (this.sendThrows) throw this.sendThrows;
    this.sent.push(data);
    const err = this.sendError;
    if (cb) queueMicrotask(() => cb(err ?? undefined));
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    if (this.readyState === 1) this.readyState = 2;
  }

  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.readyState = 3;
    // Like ws: the socket is destroyed and 'close' (1006) follows asynchronously.
    queueMicrotask(() => this.emit('close', 1006, Buffer.alloc(0)));
  }

  text(s: string): void {
    this.emit('message', Buffer.from(s), false);
  }

  binary(b: Uint8Array): void {
    this.emit('message', Buffer.from(b), true);
  }

  peerClose(code: number, reason = ''): void {
    this.readyState = 3;
    this.emit('close', code, Buffer.from(reason));
  }

  fail(err: Error): void {
    this.emit('error', err);
    this.readyState = 3;
    this.emit('close', 1006, Buffer.alloc(0));
  }
}

type Ev = [string, ...unknown[]];

class Probe extends DurableObject<{ label: string }> {
  static constructed = 0;
  events: Ev[] = [];
  /** Set by a test to make the next handler of that name fail (sync throw or async rejection). */
  failing = new Map<string, 'throw' | 'reject'>();

  constructor(ctx: DurableObjectState, env: { label: string }) {
    super(ctx, env);
    Probe.constructed++;
  }

  get state(): NodeDurableObjectState {
    return this.ctx as unknown as NodeDurableObjectState;
  }

  label(): string {
    return this.env.label;
  }

  async echo(v: { n: number[] }): Promise<{ n: number[] }> {
    v.n.push(99);
    return v;
  }

  private maybeFail(name: string): Promise<void> | void {
    const mode = this.failing.get(name);
    if (mode === 'throw') throw new Error('secret frame text');
    if (mode === 'reject') return Promise.reject(new Error('secret frame text'));
  }

  async fetch(req: Request): Promise<Response> {
    this.events.push(['fetch', new URL(req.url).pathname]);
    return new Response('ok');
  }

  webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): Promise<void> | void {
    this.events.push(['message', msg]);
    return this.maybeFail('message');
  }

  webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> | void {
    this.events.push(['close', code, reason, wasClean]);
    return this.maybeFail('close');
  }

  webSocketError(ws: WebSocket, err: unknown): Promise<void> | void {
    this.events.push(['error', (err as Error).message]);
    return this.maybeFail('error');
  }

  alarm(): Promise<void> | void {
    this.events.push(['alarm', Date.now()]);
    return this.maybeFail('alarm');
  }
}

let ns: DurableObjectNamespaceShim<Probe>;
let errors: string[];

beforeEach(() => {
  Probe.constructed = 0;
  ns = new DurableObjectNamespaceShim(Probe, () => ({ label: 'env-1' }));
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  ns.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function probe(name = 'ws-1'): Probe {
  return ns.instance(name);
}

function open(p: Probe, tags?: string[]): { server: WebSocket; raw: FakeRaw } {
  const pair = createWebSocketPair();
  const server = pair[1];
  p.state.acceptWebSocket(server, tags);
  const raw = new FakeRaw();
  attachRawSocket(server, raw);
  return { server, raw };
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('cloudflare:workers shim module', () => {
  it('exports the runtime DurableObject base class', () => {
    expect(ShimExport).toBe(DurableObject);
  });
});

describe('namespace', () => {
  it('creates one instance per name, lazily, and routes stub.fetch to it', async () => {
    const id = ns.idFromName('alpha');
    expect(ns.idFromName('alpha').toString()).toBe(id.toString());
    expect(ns.idFromName('beta').toString()).not.toBe(id.toString());
    expect(id.toString()).toMatch(/^[0-9a-f]{64}$/);
    expect(id.name).toBe('alpha');
    const stub = ns.get(id);
    expect(Probe.constructed).toBe(0);
    const res = await stub.fetch(new Request('https://hub/connect'));
    expect(await res.text()).toBe('ok');
    expect(Probe.constructed).toBe(1);
    await ns.getByName('alpha').fetch(new Request('https://hub/again'));
    expect(Probe.constructed).toBe(1);
    expect(ns.instance('alpha').events).toEqual([
      ['fetch', '/connect'],
      ['fetch', '/again'],
    ]);
    await ns.getByName('beta').fetch(new Request('https://hub/x'));
    expect(Probe.constructed).toBe(2);
  });

  it('passes env to the instance and exposes ctx.id', () => {
    const p = probe('alpha');
    expect(p.label()).toBe('env-1');
    expect(p.state.id.toString()).toBe(ns.idFromName('alpha').toString());
    expect(p.state.id.name).toBe('alpha');
  });

  it('RPC methods are async and structurally clone arguments and results', async () => {
    const stub = ns.getByName('alpha') as unknown as { echo(v: { n: number[] }): Promise<{ n: number[] }> };
    const arg = { n: [1] };
    const out = await stub.echo(arg);
    expect(arg.n).toEqual([1]);
    expect(out.n).toEqual([1, 99]);
  });

  it('a stub is not thenable and rejects unknown methods', async () => {
    const stub = ns.getByName('alpha') as unknown as Record<string, unknown>;
    expect(stub.then).toBeUndefined();
    await expect((stub as { nope(): Promise<void> }).nope()).rejects.toThrow(TypeError);
  });

  it('waitUntil work is drained', async () => {
    const p = probe();
    let done = false;
    p.state.waitUntil(new Promise<void>((r) => setTimeout(() => ((done = true), r()), 20)));
    p.state.waitUntil(Promise.reject(new Error('ignored')));
    await ns.drain();
    expect(done).toBe(true);
  });

  it('blockConcurrencyWhile runs the callback and returns its value', async () => {
    expect(await probe().state.blockConcurrencyWhile(async () => 7)).toBe(7);
  });
});

describe('attachments', () => {
  it('are per socket, null until set, and returned as copies', () => {
    const p = probe();
    const a = open(p);
    const b = open(p);
    expect(a.server.deserializeAttachment()).toBeNull();
    a.server.serializeAttachment({ userId: 'u1', channelIds: ['c1'] });
    b.server.serializeAttachment({ userId: 'u2', channelIds: [] });
    const got = a.server.deserializeAttachment() as { userId: string; channelIds: string[] };
    expect(got).toEqual({ userId: 'u1', channelIds: ['c1'] });
    got.channelIds.push('mutated');
    expect(a.server.deserializeAttachment()).toEqual({ userId: 'u1', channelIds: ['c1'] });
    expect((b.server.deserializeAttachment() as { userId: string }).userId).toBe('u2');
  });

  it(`are capped at ${ATTACHMENT_MAX_BYTES} serialized bytes, keeping the previous value`, () => {
    expect(ATTACHMENT_MAX_BYTES).toBe(2048);
    const { server } = open(probe());
    server.serializeAttachment({ ok: 1 });
    expect(() => server.serializeAttachment({ big: 'x'.repeat(ATTACHMENT_MAX_BYTES) })).toThrow(/2048/);
    expect(server.deserializeAttachment()).toEqual({ ok: 1 });
    server.serializeAttachment({ fits: 'x'.repeat(1900) });
  });

  it('reject values that cannot be cloned', () => {
    const { server } = open(probe());
    expect(() => server.serializeAttachment({ f: () => 1 })).toThrow();
  });

  it('survive for the life of the connection', async () => {
    const p = probe();
    const { server, raw } = open(p);
    server.serializeAttachment({ n: 1 });
    raw.text('a');
    raw.text('b');
    await tick();
    expect(server.deserializeAttachment()).toEqual({ n: 1 });
  });
});

describe('message dispatch and auto-response', () => {
  it('delivers text as strings and binary as ArrayBuffers, in order', async () => {
    const p = probe();
    const { raw } = open(p);
    raw.text('one');
    raw.binary(new Uint8Array([1, 2, 3]));
    raw.text('two');
    await tick();
    expect(p.events.map((e) => e[0])).toEqual(['message', 'message', 'message']);
    expect(p.events[0]![1]).toBe('one');
    const bin = p.events[1]![1] as ArrayBuffer;
    expect(bin).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(bin)]).toEqual([1, 2, 3]);
    expect(p.events[2]![1]).toBe('two');
  });

  it('answers the auto-response request without waking the handler', async () => {
    const p = probe();
    p.state.setWebSocketAutoResponse({ request: '{"t":"ping"}', response: '{"t":"pong"}' } as WebSocketRequestResponsePair);
    const { server, raw } = open(p);
    expect(p.state.getWebSocketAutoResponseTimestamp(server)).toBeNull();
    raw.text('{"t":"ping"}');
    await tick();
    expect(raw.sent).toEqual(['{"t":"pong"}']);
    expect(p.events).toEqual([]);
    expect(p.state.getWebSocketAutoResponseTimestamp(server)).toBeInstanceOf(Date);
    // Anything else (even a near-identical ping) reaches the handler.
    raw.text('{"t": "ping"}');
    raw.binary(new TextEncoder().encode('{"t":"ping"}'));
    await tick();
    expect(p.events.length).toBe(2);
    expect(raw.sent).toEqual(['{"t":"pong"}']);
    expect(p.state.getWebSocketAutoResponse()?.request).toBe('{"t":"ping"}');
    p.state.setWebSocketAutoResponse();
    expect(p.state.getWebSocketAutoResponse()).toBeNull();
    raw.text('{"t":"ping"}');
    await tick();
    expect(p.events.length).toBe(3);
  });

  it('sends text and binary frames to the peer', () => {
    const { server, raw } = open(probe());
    server.send('hi');
    server.send(new Uint8Array([7]));
    expect(raw.sent[0]).toBe('hi');
    expect(raw.sent.length).toBe(2);
  });
});

describe('close and error', () => {
  it('getWebSockets lists accepted sockets by tag and excludes closed ones', async () => {
    const p = probe();
    const a = open(p, ['u1']);
    const b = open(p, ['u2']);
    const c = open(p, ['u1']);
    expect(p.state.getWebSockets()).toEqual([a.server, b.server, c.server]);
    expect(p.state.getWebSockets('u1')).toEqual([a.server, c.server]);
    expect(p.state.getTags(a.server)).toEqual(['u1']);
    a.raw.peerClose(1000, 'bye');
    await tick();
    expect(a.server.readyState).toBe(WebSocket.CLOSED);
    expect(p.state.getWebSockets()).toEqual([b.server, c.server]);
    expect(p.state.getWebSockets('u1')).toEqual([c.server]);
    expect(p.events).toEqual([['close', 1000, 'bye', true]]);
  });

  it('reports an abnormal close as not clean', async () => {
    const p = probe();
    const { raw } = open(p);
    raw.peerClose(1006);
    await tick();
    expect(p.events).toEqual([['close', 1006, '', false]]);
  });

  it('an error dispatches webSocketError once and no close afterwards', async () => {
    const p = probe();
    const { server, raw } = open(p);
    raw.fail(new Error('ECONNRESET'));
    await tick();
    expect(p.events).toEqual([['error', 'ECONNRESET']]);
    expect(server.readyState).toBe(WebSocket.CLOSED);
    expect(p.state.getWebSockets()).toEqual([]);
  });

  it('a hub-initiated close is CLOSING until the peer answers, then CLOSED', async () => {
    const p = probe();
    const { server, raw } = open(p);
    server.close(4001, 'deactivated');
    expect(raw.closes).toEqual([{ code: 4001, reason: 'deactivated' }]);
    expect(server.readyState).toBe(WebSocket.CLOSING);
    expect(p.state.getWebSockets()).toEqual([server]);
    raw.peerClose(4001, 'deactivated');
    await tick();
    expect(server.readyState).toBe(WebSocket.CLOSED);
    expect(p.state.getWebSockets()).toEqual([]);
    // Closing again (the hub echoing a close) is harmless.
    server.close(4001, 'deactivated');
    expect(raw.closes.length).toBe(1);
  });

  it('close rejects codes a peer may not send, like workerd', () => {
    const { server } = open(probe());
    expect(() => server.close(1005)).toThrow(TypeError);
    expect(() => server.close(1006)).toThrow(TypeError);
    expect(server.readyState).toBe(WebSocket.OPEN);
  });

  it('a send while the socket dies does not throw and logs nothing about the frame', async () => {
    const p = probe();
    const { server, raw } = open(p);
    raw.sendError = new Error('write EPIPE');
    expect(() => server.send('frame body')).not.toThrow();
    raw.sendThrows = new Error('WebSocket is not open: readyState 2 (CLOSING)');
    expect(() => server.send('frame body')).not.toThrow();
    await tick();
    expect(errors.join('\n')).not.toContain('frame body');
  });

  it('a send after the socket closed throws (the hub catches it), like workerd', async () => {
    const p = probe();
    const { server, raw } = open(p);
    raw.peerClose(1000);
    await tick();
    expect(() => server.send('late')).toThrow();
    expect(raw.sent).toEqual([]);
  });

  it('frames and a close issued before the connection is attached are delivered on attach', () => {
    const p = probe();
    const pair = createWebSocketPair();
    const server = pair[1];
    p.state.acceptWebSocket(server, ['u']);
    expect(server.readyState).toBe(WebSocket.OPEN);
    server.send('early');
    server.close(4001, 'deactivated');
    expect(server.readyState).toBe(WebSocket.CLOSING);
    const raw = new FakeRaw();
    attachRawSocket(server, raw);
    expect(raw.sent).toEqual(['early']);
    expect(raw.closes).toEqual([{ code: 4001, reason: 'deactivated' }]);
  });

  it('a socket that never gets its connection closes as 1006 and leaves the list', async () => {
    const p = probe();
    const pair = createWebSocketPair();
    p.state.acceptWebSocket(pair[1], ['u']);
    pair[1].serializeAttachment({ userId: 'u' });
    const { abandonSocket } = await import('../src/platform/do-runtime');
    abandonSocket(pair[1]);
    await tick();
    expect(p.state.getWebSockets()).toEqual([]);
    expect(p.events).toEqual([['close', 1006, '', false]]);
  });

  it('acceptWebSocket only takes server ends created by the runtime, once', () => {
    const p = probe();
    const pair = createWebSocketPair();
    expect(() => p.state.acceptWebSocket(pair[0])).toThrow(TypeError);
    p.state.acceptWebSocket(pair[1]);
    expect(() => p.state.acceptWebSocket(pair[1])).toThrow(TypeError);
  });
});

describe('handler errors never crash the process', () => {
  it.each(['throw', 'reject'] as const)('message handler that %ss is logged without the frame, later frames still dispatch', async (mode) => {
    const p = probe();
    const { raw } = open(p);
    p.failing.set('message', mode);
    raw.text('secret frame text');
    await tick();
    p.failing.delete('message');
    raw.text('next');
    await tick();
    expect(p.events.map((e) => e[1])).toEqual(['secret frame text', 'next']);
    expect(errors.length).toBe(1);
    expect(JSON.parse(errors[0]!)).toEqual({ level: 'error', code: 'do_handler_failed', handler: 'webSocketMessage' });
    expect(errors[0]).not.toContain('secret');
  });

  it.each(['close', 'error'] as const)('a failing %s handler is logged', async (which) => {
    const p = probe();
    const { raw } = open(p);
    p.failing.set(which, 'reject');
    if (which === 'close') raw.peerClose(1000);
    else raw.fail(new Error('boom'));
    await tick();
    expect(errors.map((e) => JSON.parse(e).handler)).toEqual([which === 'close' ? 'webSocketClose' : 'webSocketError']);
    expect(errors.join()).not.toContain('secret');
  });

  it('a failing alarm is logged and does not stop later alarms', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const p = probe();
    p.failing.set('alarm', 'throw');
    await p.state.storage.setAlarm(Date.now() + 10);
    await vi.advanceTimersByTimeAsync(10);
    expect(errors.map((e) => JSON.parse(e).handler)).toEqual(['alarm']);
    p.failing.delete('alarm');
    await p.state.storage.setAlarm(Date.now() + 10);
    await vi.advanceTimersByTimeAsync(10);
    expect(p.events.filter((e) => e[0] === 'alarm').length).toBe(2);
  });
});

describe('alarms', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });

  it('fire once at the set time and clear', async () => {
    const p = probe();
    const at = Date.now() + 1_000;
    await p.state.storage.setAlarm(at);
    expect(await p.state.storage.getAlarm()).toBe(at);
    await vi.advanceTimersByTimeAsync(999);
    expect(p.events).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(p.events).toEqual([['alarm', at]]);
    expect(await p.state.storage.getAlarm()).toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(p.events.length).toBe(1);
  });

  it('setting again replaces the pending alarm (earlier or later)', async () => {
    const p = probe();
    const t0 = Date.now();
    await p.state.storage.setAlarm(t0 + 1_000);
    await p.state.storage.setAlarm(t0 + 500);
    await vi.advanceTimersByTimeAsync(500);
    expect(p.events).toEqual([['alarm', t0 + 500]]);
    await p.state.storage.setAlarm(new Date(t0 + 2_000));
    await p.state.storage.setAlarm(t0 + 3_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(p.events).toEqual([
      ['alarm', t0 + 500],
      ['alarm', t0 + 3_000],
    ]);
  });

  it('re-arms when the handler sets a new alarm', async () => {
    const p = probe();
    let left = 2;
    p.alarm = async function () {
      p.events.push(['alarm', Date.now()]);
      if (left-- > 0) await p.state.storage.setAlarm(Date.now() + 100);
    };
    await p.state.storage.setAlarm(Date.now() + 100);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(p.events.length).toBe(3);
    expect(await p.state.storage.getAlarm()).toBeNull();
  });

  it('deleteAlarm cancels; a past time fires promptly', async () => {
    const p = probe();
    await p.state.storage.setAlarm(Date.now() + 100);
    await p.state.storage.deleteAlarm();
    expect(await p.state.storage.getAlarm()).toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(p.events).toEqual([]);
    await p.state.storage.setAlarm(Date.now() - 5_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(p.events.length).toBe(1);
  });

  it('handles delays beyond the 32-bit timer limit', async () => {
    const p = probe();
    const at = Date.now() + 2 ** 31 + 5_000;
    await p.state.storage.setAlarm(at);
    await vi.advanceTimersByTimeAsync(2 ** 31);
    expect(p.events).toEqual([]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(p.events).toEqual([['alarm', at]]);
  });

  it('runAlarm fires a pending alarm now (test hook), and reports when none is set', async () => {
    const p = probe('alpha');
    expect(await ns.runAlarm('alpha')).toBe(false);
    await p.state.storage.setAlarm(Date.now() + 60_000);
    expect(await ns.runAlarm('alpha')).toBe(true);
    expect(p.events.length).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(p.events.length).toBe(1);
  });

  it('dispose clears every pending alarm', async () => {
    const p = probe();
    await p.state.storage.setAlarm(Date.now() + 100);
    ns.dispose();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(p.events).toEqual([]);
  });
});

describe('closeAll (graceful shutdown)', () => {
  it('closes every accepted socket with the given code', () => {
    const p = probe('a');
    const q = probe('b');
    const s1 = open(p);
    const s2 = open(q);
    ns.closeAll(1001, 'going away');
    expect(s1.raw.closes).toEqual([{ code: 1001, reason: 'going away' }]);
    expect(s2.raw.closes).toEqual([{ code: 1001, reason: 'going away' }]);
  });
});

describe('outbound backpressure', () => {
  it(`defaults to ${MAX_BUFFERED_BYTES} bytes (4 MiB)`, () => {
    expect(MAX_BUFFERED_BYTES).toBe(4 * 1024 * 1024);
  });

  it('a socket whose peer stops reading is terminated past the cap; the close path cleans it up; others carry on', async () => {
    const small = new DurableObjectNamespaceShim(Probe, () => ({ label: 'x' }), { maxBufferedBytes: 1_000 });
    try {
      const p = small.instance('w');
      const slow = open(p, ['slow']);
      const fine = open(p, ['fine']);
      slow.raw.bufferedAmount = 999;
      slow.server.send('a'); // at the cap: still fine
      expect(slow.raw.terminated).toBe(false);
      slow.raw.bufferedAmount = 1_001;
      expect(() => slow.server.send('b')).not.toThrow();
      expect(slow.raw.terminated).toBe(true);
      await tick();
      expect(p.events).toEqual([['close', 1006, '', false]]);
      expect(p.state.getWebSockets()).toEqual([fine.server]);
      fine.raw.bufferedAmount = 900;
      fine.server.send('still');
      expect(fine.raw.terminated).toBe(false);
      expect(fine.raw.sent).toEqual(['still']);
    } finally {
      small.dispose();
    }
  });

  it('frames held before attach count too: a peer already backed up is terminated on flush', async () => {
    const small = new DurableObjectNamespaceShim(Probe, () => ({ label: 'x' }), { maxBufferedBytes: 10 });
    try {
      const p = small.instance('w');
      const pair = createWebSocketPair();
      p.state.acceptWebSocket(pair[1]);
      pair[1].send('held');
      const raw = new FakeRaw();
      raw.bufferedAmount = 50;
      attachRawSocket(pair[1], raw);
      expect(raw.terminated).toBe(true);
    } finally {
      small.dispose();
    }
  });

  it('the default namespace uses the 4 MiB cap', () => {
    const { server, raw } = open(probe());
    raw.bufferedAmount = MAX_BUFFERED_BYTES;
    server.send('ok');
    expect(raw.terminated).toBe(false);
    raw.bufferedAmount = MAX_BUFFERED_BYTES + 1;
    server.send('over');
    expect(raw.terminated).toBe(true);
  });
});

describe('drain waits for in-flight handlers', () => {
  it.each(['message', 'close', 'alarm'] as const)('a slow %s handler keeps drain() pending until it finishes', async (which) => {
    const p = probe();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let finished = false;
    const slow = async () => {
      await gate;
      finished = true;
    };
    if (which === 'message') p.webSocketMessage = slow;
    else if (which === 'close') p.webSocketClose = slow;
    else p.alarm = slow;
    const { raw } = open(p);
    if (which === 'message') raw.text('x');
    else if (which === 'close') raw.peerClose(1000);
    else {
      await p.state.storage.setAlarm(Date.now() + 60_000);
      void ns.runAlarm('ws-1');
    }
    await tick();
    let drained = false;
    const d = ns.drain().then(() => (drained = true));
    await new Promise((r) => setTimeout(r, 30));
    expect(drained).toBe(false);
    release();
    await d;
    expect(finished).toBe(true);
  });

  it('a handler that rejects does not break drain', async () => {
    const p = probe();
    p.failing.set('message', 'reject');
    const { raw } = open(p);
    raw.text('x');
    await ns.drain();
    expect(errors.length).toBe(1);
  });
});
