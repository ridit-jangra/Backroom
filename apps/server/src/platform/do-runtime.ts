/**
 * Durable Object runtime for Node: just enough of workerd's Durable Object API to run `WorkspaceHub` unchanged.
 *
 * There is no hibernation. Each object is one in-memory instance per name for the life of the process, created on
 * its first request. Its sockets are `NodeWebSocket`s, server ends of a `createWebSocketPair()` that are joined to a
 * real `ws` connection by the upgrade bridge (ws-bridge.ts). The hibernation API is kept: per-socket attachments
 * (capped at 2 KiB, as on workerd), tags, the ping/pong auto-response that never wakes the object, and the
 * `webSocketMessage` / `webSocketClose` / `webSocketError` / `alarm` handlers. Alarms are timers.
 *
 * Handler failures (a sync throw or a rejection) are caught and logged by handler name only: frames carry message
 * bodies, so neither arguments nor error messages are logged. Nothing a socket does can crash the process.
 *
 * Differences from workerd, none of which the hub relies on: `blockConcurrencyWhile` does not gate other events, a
 * failed alarm is not retried, `storage` only has the alarm methods (the hub keeps no data in storage), and RPC
 * calls run in-process (arguments and results are still structured-cloned).
 */
import { createHash } from 'node:crypto';
import { deserialize, serialize } from 'node:v8';

/** workerd's limit for `serializeAttachment` (bytes of V8-serialized data). */
export const ATTACHMENT_MAX_BYTES = 2048;
/**
 * Outbound bytes a socket may have queued (ws `bufferedAmount`) before it is terminated: a peer that stops
 * reading must not grow server memory without bound. Termination takes the normal abnormal-close path (1006).
 */
export const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;
/** setTimeout's largest delay; longer alarms re-arm in steps. */
const MAX_TIMER_MS = 2 ** 31 - 1;
const MAX_TAGS = 10;
const MAX_TAG_CHARS = 256;

type Frame = string | ArrayBuffer | ArrayBufferView;

/** The part of a `ws` WebSocket the runtime uses (a structural type, so tests can stand in for it). */
export interface RawSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: Frame, cb?: (err?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: 'message', listener: (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => void): unknown;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

type HandlerName = 'webSocketMessage' | 'webSocketClose' | 'webSocketError' | 'alarm';

function logHandlerFailure(handler: string): void {
  console.error(JSON.stringify({ level: 'error', code: 'do_handler_failed', handler }));
}

/** Runs `target[name](...args)` if it exists; never throws or rejects. */
function invoke(target: object, name: HandlerName, args: unknown[]): Promise<void> {
  const fn = (target as Record<string, unknown>)[name];
  if (typeof fn !== 'function') return Promise.resolve();
  try {
    return Promise.resolve(fn.apply(target, args)).then(
      () => undefined,
      () => logHandlerFailure(name),
    );
  } catch {
    logHandlerFailure(name);
    return Promise.resolve();
  }
}

/** Close codes an endpoint may send (RFC 6455 §7.4), the same check as `ws` and workerd. */
function validCloseCode(code: number): boolean {
  return (Number.isInteger(code) && code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) ||
    (Number.isInteger(code) && code >= 3000 && code <= 4999);
}

function toArrayBuffer(data: Buffer | ArrayBuffer | Buffer[]): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  const buf = Array.isArray(data) ? Buffer.concat(data) : data;
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function toText(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return (Array.isArray(data) ? Buffer.concat(data) : data).toString('utf8');
}

/**
 * The server end of a pair: what the hub sees as a `WebSocket`. It reports OPEN from creation (like an accepted
 * workerd socket); frames and a close issued before the real connection is attached are held and delivered on
 * attach, in order.
 */
export class NodeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  #state = OPEN;
  #raw: RawSocket | null = null;
  #pending: Frame[] = [];
  #pendingClose: { code?: number; reason?: string } | null = null;
  #attachment: Buffer | null = null;
  #owner: NodeDurableObjectState | null = null;
  #tags: readonly string[] = [];
  /** A close or error handler has been dispatched (exactly one ever is). */
  #gone = false;
  #autoResponseAt: Date | null = null;

  get readyState(): number {
    return this.#state;
  }

  send(data: Frame): void {
    if (this.#state !== OPEN) throw new TypeError("Can't call WebSocket send() after close().");
    if (this.#raw) this.#rawSend(data);
    else this.#pending.push(data);
  }

  close(code?: number, reason?: string): void {
    if (code !== undefined && !validCloseCode(code)) throw new TypeError('Invalid WebSocket close code.');
    if (reason !== undefined && Buffer.byteLength(reason) > 123) throw new TypeError('WebSocket close reason too long.');
    if (this.#state !== OPEN) return;
    this.#state = CLOSING;
    if (!this.#raw) {
      this.#pendingClose = { code, reason };
      return;
    }
    try {
      this.#raw.close(code, reason);
    } catch {
      // the connection is already going away; its close event finishes the job
    }
  }

  serializeAttachment(value: unknown): void {
    const buf = serialize(value);
    if (buf.byteLength > ATTACHMENT_MAX_BYTES) {
      throw new Error(`WebSocket attachment exceeds the ${ATTACHMENT_MAX_BYTES} byte limit (${buf.byteLength} bytes).`);
    }
    this.#attachment = buf;
  }

  deserializeAttachment(): unknown {
    return this.#attachment === null ? null : deserialize(this.#attachment);
  }

  /** @internal */
  get tags(): readonly string[] {
    return this.#tags;
  }

  /** @internal */
  get autoResponseAt(): Date | null {
    return this.#autoResponseAt;
  }

  /** @internal Called by `acceptWebSocket`. */
  adopt(owner: NodeDurableObjectState, tags: readonly string[]): void {
    if (this.#owner) throw new TypeError('This WebSocket has already been accepted.');
    this.#owner = owner;
    this.#tags = tags;
  }

  /** @internal Joins the real connection (ws-bridge.ts), then delivers what was held. */
  attachRaw(raw: RawSocket): void {
    if (this.#raw) throw new TypeError('This WebSocket is already connected.');
    if (this.#state === CLOSED) {
      raw.terminate();
      return;
    }
    this.#raw = raw;
    raw.on('message', (data, isBinary) => this.#onMessage(isBinary ? toArrayBuffer(data) : toText(data)));
    raw.on('close', (code, reason) => this.#onClose(code, reason.toString('utf8')));
    raw.on('error', (err) => this.#onError(err));
    for (const f of this.#pending.splice(0)) this.#rawSend(f);
    const pc = this.#pendingClose;
    this.#pendingClose = null;
    if (pc) {
      try {
        raw.close(pc.code, pc.reason);
      } catch {
        raw.terminate();
      }
    }
  }

  /**
   * @internal The connection will never be attached (the handshake failed or the client left first). Behaves
   * like an abnormal close: an accepted socket the object had not closed itself gets `webSocketClose(1006)`.
   */
  abandon(): void {
    if (this.#raw || this.#state === CLOSED) return;
    const closedByObject = this.#state === CLOSING;
    this.#pending = [];
    this.#pendingClose = null;
    this.#finish();
    if (!closedByObject) this.#owner?.dispatch('webSocketClose', [this, 1006, '', false]);
  }

  #rawSend(data: Frame): void {
    const raw = this.#raw!;
    try {
      // The callback swallows write errors: a socket dying mid-send reports itself through its close event.
      raw.send(data, () => {});
    } catch {
      // ws throws synchronously for a connection that is no longer open; same as above
    }
    if (raw.bufferedAmount > (this.#owner?.maxBufferedBytes ?? MAX_BUFFERED_BYTES)) raw.terminate();
  }

  #onMessage(msg: string | ArrayBuffer): void {
    const owner = this.#owner;
    if (!owner || this.#state === CLOSED) return;
    const auto = owner.autoResponse;
    if (auto && typeof msg === 'string' && msg === auto.request) {
      this.#autoResponseAt = new Date();
      this.#rawSend(auto.response);
      return;
    }
    void owner.dispatch('webSocketMessage', [this, msg]);
  }

  #onClose(code: number, reason: string): void {
    if (this.#gone) return;
    this.#finish();
    void this.#owner?.dispatch('webSocketClose', [this, code, reason, code !== 1006]);
  }

  #onError(err: Error): void {
    if (this.#gone) return;
    this.#finish();
    void this.#owner?.dispatch('webSocketError', [this, err]);
  }

  #finish(): void {
    this.#gone = true;
    this.#state = CLOSED;
    this.#owner?.forget(this);
  }
}

/** The client end of a pair: opaque on Node, handed back to the bridge through the upgrade response. */
export class NodeWebSocketClientEnd {
  constructor(readonly server: NodeWebSocket) {}
}

/** `new WebSocketPair()` for Node: `[client, server]`. */
export function createWebSocketPair(): { 0: WebSocket; 1: WebSocket } {
  const server = new NodeWebSocket();
  const client = new NodeWebSocketClientEnd(server);
  return { 0: client as unknown as WebSocket, 1: server as unknown as WebSocket };
}

function asServerEnd(ws: WebSocket): NodeWebSocket {
  const s = ws as unknown;
  if (!(s instanceof NodeWebSocket)) throw new TypeError('Expected the server end of a WebSocketPair.');
  return s;
}

/** Joins a pair's server end to its real connection. */
export function attachRawSocket(server: WebSocket, raw: RawSocket): void {
  asServerEnd(server).attachRaw(raw);
}

/** Marks a pair's server end as never connected (see `NodeWebSocket.abandon`). */
export function abandonSocket(server: WebSocket): void {
  asServerEnd(server).abandon();
}

export class NodeDurableObjectId {
  readonly #hex: string;
  constructor(readonly name: string) {
    this.#hex = createHash('sha256').update(name).digest('hex');
  }
  toString(): string {
    return this.#hex;
  }
  equals(other: unknown): boolean {
    return other instanceof NodeDurableObjectId && other.#hex === this.#hex;
  }
}

/** `ctx.storage`, alarms only. One timer per object; setting replaces it; it fires once. */
export class NodeAlarmStorage {
  #at: number | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** Set by dispose(): later setAlarm calls (e.g. from a handler still running at shutdown) arm nothing. */
  #disposed = false;

  constructor(private readonly fire: () => Promise<void>) {}

  async getAlarm(): Promise<number | null> {
    return this.#at;
  }

  async setAlarm(scheduledTime: number | Date): Promise<void> {
    const at = typeof scheduledTime === 'number' ? scheduledTime : scheduledTime.getTime();
    if (!Number.isFinite(at)) throw new TypeError('setAlarm() requires a valid time.');
    if (this.#disposed) return;
    this.#at = at;
    this.#arm();
  }

  async deleteAlarm(): Promise<void> {
    this.#at = null;
    this.#clear();
  }

  /** Fires the pending alarm now; false when none is set. */
  async runNow(): Promise<boolean> {
    this.#clear();
    if (this.#at === null) return false;
    // Cleared before the handler runs, so a setAlarm() inside it arms the next one.
    this.#at = null;
    await this.fire();
    return true;
  }

  /** @internal */
  dispose(): void {
    this.#disposed = true;
    this.#at = null;
    this.#clear();
  }

  #clear(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #arm(): void {
    this.#clear();
    if (this.#at === null || this.#disposed) return;
    const delay = Math.min(Math.max(0, this.#at - Date.now()), MAX_TIMER_MS);
    const timer = setTimeout(() => {
      if (this.#timer !== timer) return;
      this.#timer = undefined;
      if (this.#at === null) return;
      if (this.#at > Date.now()) this.#arm();
      else void this.runNow();
    }, delay);
    timer.unref?.();
    this.#timer = timer;
  }
}

/** The `ctx` handed to an object: the calls `WorkspaceHub` makes. */
export class NodeDurableObjectState {
  readonly storage: NodeAlarmStorage;
  #target: object | null = null;
  #sockets = new Set<NodeWebSocket>();
  #autoResponse: { request: string; response: string } | null = null;
  #pendingWork = new Set<Promise<unknown>>();

  constructor(
    readonly id: NodeDurableObjectId,
    /** @internal See MAX_BUFFERED_BYTES. */
    readonly maxBufferedBytes: number = MAX_BUFFERED_BYTES,
  ) {
    this.storage = new NodeAlarmStorage(() => this.dispatch('alarm', [{ retryCount: 0, isRetry: false }]));
  }

  /** @internal Set once the object is constructed. */
  bind(target: object): void {
    this.#target = target;
  }

  /** @internal */
  get autoResponse(): { request: string; response: string } | null {
    return this.#autoResponse;
  }

  acceptWebSocket(ws: WebSocket, tags: string[] = []): void {
    const s = asServerEnd(ws);
    if (tags.length > MAX_TAGS) throw new TypeError(`A WebSocket can have at most ${MAX_TAGS} tags.`);
    for (const t of tags) {
      if (typeof t !== 'string' || t.length > MAX_TAG_CHARS) throw new TypeError(`A WebSocket tag must be a string of at most ${MAX_TAG_CHARS} characters.`);
    }
    s.adopt(this, [...tags]);
    this.#sockets.add(s);
  }

  /** Accepted sockets that have not closed, in accept order (a closing socket is still listed, as on workerd). */
  getWebSockets(tag?: string): WebSocket[] {
    const out: WebSocket[] = [];
    for (const s of this.#sockets) {
      if (s.readyState === CLOSED) continue;
      if (tag === undefined || s.tags.includes(tag)) out.push(s as unknown as WebSocket);
    }
    return out;
  }

  getTags(ws: WebSocket): string[] {
    return [...asServerEnd(ws).tags];
  }

  setWebSocketAutoResponse(pair?: WebSocketRequestResponsePair): void {
    this.#autoResponse = pair ? { request: pair.request, response: pair.response } : null;
  }

  getWebSocketAutoResponse(): WebSocketRequestResponsePair | null {
    return this.#autoResponse ? ({ ...this.#autoResponse } as WebSocketRequestResponsePair) : null;
  }

  getWebSocketAutoResponseTimestamp(ws: WebSocket): Date | null {
    return asServerEnd(ws).autoResponseAt;
  }

  waitUntil(promise: Promise<unknown>): void {
    this.#track(promise);
  }

  /** Adds work that `drain()` waits for; removed once it settles (a rejection is swallowed here). */
  #track(promise: Promise<unknown>): void {
    const p: Promise<unknown> = Promise.resolve(promise)
      .catch(() => {})
      .finally(() => this.#pendingWork.delete(p));
    this.#pendingWork.add(p);
  }

  async blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
    return callback();
  }

  /** @internal Runs a handler on the object; never throws. Tracked, so `drain()` waits for it. */
  dispatch(name: HandlerName, args: unknown[]): Promise<void> {
    if (!this.#target) return Promise.resolve();
    const p = invoke(this.#target, name, args);
    this.#track(p);
    return p;
  }

  /** @internal */
  forget(s: NodeWebSocket): void {
    this.#sockets.delete(s);
  }

  /** @internal Waits for `waitUntil` work and running handlers, including any started meanwhile. */
  async drain(): Promise<void> {
    while (this.#pendingWork.size > 0) await Promise.all([...this.#pendingWork]);
  }

  /** @internal */
  closeAll(code: number, reason: string): void {
    for (const ws of this.getWebSockets()) {
      try {
        ws.close(code, reason);
      } catch {
        // already closing
      }
    }
  }
}

/** Base class standing in for `DurableObject` from `cloudflare:workers`. */
export class DurableObject<Env = unknown> {
  protected ctx: DurableObjectState;
  protected env: Env;
  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

type ObjectClass<T> = new (ctx: DurableObjectState, env: never) => T;

/**
 * The `HUB` binding: `idFromName`, `get(id)` and `getByName(name)` return stubs whose `fetch` and RPC methods call
 * the one instance for that name, constructed on first use.
 */
export class DurableObjectNamespaceShim<T extends object> {
  #objects = new Map<string, { instance: T; state: NodeDurableObjectState }>();

  constructor(
    private readonly cls: ObjectClass<T>,
    private readonly getEnv: () => unknown,
    private readonly opts: { maxBufferedBytes?: number } = {},
  ) {}

  idFromName(name: string): NodeDurableObjectId {
    return new NodeDurableObjectId(name);
  }

  get(id: DurableObjectId | NodeDurableObjectId): DurableObjectStub {
    if (!(id instanceof NodeDurableObjectId)) throw new TypeError('get() requires an id from idFromName().');
    return this.#stub(id);
  }

  getByName(name: string): DurableObjectStub {
    return this.#stub(this.idFromName(name));
  }

  /** The instance for `name`, constructed if needed (also the hook tests use in place of `runInDurableObject`). */
  instance(name: string): T {
    return this.#object(name).instance;
  }

  has(name: string): boolean {
    return this.#objects.has(name);
  }

  /** Fires the object's pending alarm now (like `runDurableObjectAlarm`); false when none is set or no object. */
  async runAlarm(name: string): Promise<boolean> {
    const o = this.#objects.get(name);
    return o ? o.state.storage.runNow() : false;
  }

  /** Closes every accepted socket of every object (graceful shutdown uses 1001). */
  closeAll(code: number, reason: string): void {
    for (const { state } of this.#objects.values()) state.closeAll(code, reason);
  }

  /** Waits for all `waitUntil` work and every handler still running (graceful shutdown). */
  async drain(): Promise<void> {
    await Promise.all([...this.#objects.values()].map(({ state }) => state.drain()));
  }

  /** Cancels every alarm timer (shutdown and tests). Sockets are left to `closeAll`. */
  dispose(): void {
    for (const { state } of this.#objects.values()) state.storage.dispose();
  }

  #object(name: string): { instance: T; state: NodeDurableObjectState } {
    let o = this.#objects.get(name);
    if (!o) {
      const state = new NodeDurableObjectState(new NodeDurableObjectId(name), this.opts.maxBufferedBytes);
      const instance = new this.cls(state as unknown as DurableObjectState, this.getEnv() as never);
      state.bind(instance);
      o = { instance, state };
      this.#objects.set(name, o);
    }
    return o;
  }

  #stub(id: NodeDurableObjectId): DurableObjectStub {
    const name = id.name;
    const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const inst = this.instance(name) as { fetch?: (r: Request) => Promise<Response> | Response };
      if (typeof inst.fetch !== 'function') throw new TypeError('The Durable Object does not implement fetch().');
      return inst.fetch(input instanceof Request && init === undefined ? input : new Request(input, init));
    };
    return new Proxy({} as DurableObjectStub, {
      get: (_t, prop) => {
        if (typeof prop === 'symbol' || prop === 'then') return undefined;
        if (prop === 'id') return id;
        if (prop === 'name') return name;
        if (prop === 'fetch') return fetch;
        return async (...args: unknown[]) => {
          const inst = this.instance(name) as Record<string, unknown>;
          const method = inst[prop];
          if (typeof method !== 'function') throw new TypeError(`The RPC receiver does not implement the method "${prop}".`);
          return structuredClone(await method.apply(inst, structuredClone(args)));
        };
      },
    });
  }
}
