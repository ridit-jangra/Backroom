import { type IncomingMessage, type Server, createServer } from 'node:http';
import { join } from 'node:path';
import { ACTIVE_WINDOW_MS, PING_FRAME, parseHubFrame, type ClientFrame, type HubFrame } from '@backroom/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
// The real worker application and hub, run unchanged on the Node shim.
import { createApp } from '../../worker/src/app';
import { createSession } from '../../worker/src/auth/sessions';
import type { Env } from '../../worker/src/env';
import { WorkspaceHub } from '../../worker/src/hub/WorkspaceHub';
import { type NodeD1Database, createD1 } from '../src/platform/d1';
import { DurableObjectNamespaceShim } from '../src/platform/do-runtime';
import { createFsBlobStore } from '../src/platform/fs-blobs';
import { applyMigrations } from '../src/platform/migrate';
import { type UpgradeBridge, createUpgradeBridge } from '../src/platform/ws-bridge';
import { MIGRATIONS_DIR, listenLocal, tempDir } from './helpers';

const WS_ID = '01JCLUBHACK0000000000000WS';
const GENERAL = '01JCLUBHACK0000000000000GN';
const ALICE = '01JALICE000000000000000000';
const BOB = '01JB0B00000000000000000000';
const CAROL = '01JCAR0L000000000000000000';
const T = 1_800_000_000_000;

type Frame = HubFrame;

/** Mirrors apps/worker/test/ws.ts: frames by type, waiting when none is queued. */
class Client {
  frames: Frame[] = [];
  private queue: Frame[] = [];
  private waiters: { t: Frame['t']; resolve: (f: Frame) => void }[] = [];
  private closeInfo: { code: number; reason: string } | null = null;
  private closeWaiters: ((c: { code: number; reason: string }) => void)[] = [];

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const f = parseHubFrame(data.toString());
      if (!f) throw new Error('unparseable hub frame');
      this.frames.push(f);
      const i = this.waiters.findIndex((w) => w.t === f.t);
      if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(f);
      else this.queue.push(f);
    });
    ws.on('close', (code, reason) => {
      this.closeInfo = { code, reason: reason.toString() };
      for (const w of this.closeWaiters.splice(0)) w(this.closeInfo);
    });
  }

  send(f: ClientFrame | string): void {
    this.ws.send(typeof f === 'string' ? f : JSON.stringify(f));
  }

  next<K extends Frame['t']>(t: K, timeoutMs = 3_000): Promise<Extract<Frame, { t: K }>> {
    const i = this.queue.findIndex((f) => f.t === t);
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0] as never);
    return new Promise((resolve, reject) => {
      const w = { t, resolve: resolve as (f: Frame) => void };
      this.waiters.push(w);
      setTimeout(() => {
        const j = this.waiters.indexOf(w);
        if (j >= 0) {
          this.waiters.splice(j, 1);
          reject(new Error(`timed out waiting for '${t}' frame`));
        }
      }, timeoutMs);
    });
  }

  async none(t: Frame['t'], ms = 150): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
    const f = this.queue.find((x) => x.t === t);
    if (f) throw new Error(`unexpected '${t}' frame`);
  }

  closed(): Promise<{ code: number; reason: string }> {
    if (this.closeInfo) return Promise.resolve(this.closeInfo);
    return new Promise((r) => this.closeWaiters.push(r));
  }
}

let db: NodeD1Database;
let hubs: DurableObjectNamespaceShim<WorkspaceHub>;
let env: Env;
let bridge: UpgradeBridge;
let server: Server;
let origin: string;
let port: number;
const clients: Client[] = [];
/** Test hook: replaces the app's response before the bridge sees it. */
let app: ReturnType<typeof createApp>;
let wrapResponse: ((r: Response) => Response) | null = null;
const tokens = new Map<string, string>();

function toRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const x of v) headers.append(k, x);
    else headers.set(k, v);
  }
  return new Request(new URL(req.url ?? '/', origin), { method: req.method, headers });
}

async function addUser(id: string, name: string, sessionAt = Date.now()): Promise<void> {
  await db.batch([
    db.prepare('INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, 0)').bind(id, `${name}@test.dev`, name),
    db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'member', 0)").bind(WS_ID, id),
    db.prepare('INSERT INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, 0)').bind(GENERAL, id),
  ]);
  tokens.set(id, await createSession(db, id, null, sessionAt));
}

function openSocket(headers: Record<string, string>): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/ws?workspace=clubhack`, { headers });
}

async function connect(userId: string): Promise<Client> {
  const ws = openSocket({ Cookie: `backroom_session=${tokens.get(userId)}`, Origin: origin });
  const c = new Client(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`upgrade failed: ${res.statusCode}`)));
  });
  clients.push(c);
  return c;
}

function hub(): WorkspaceHub {
  return hubs.instance(WS_ID);
}

const count = async (sql: string) => (await db.prepare(sql).first<{ n: number }>())!.n;

beforeEach(async () => {
  const dir = tempDir();
  db = createD1(join(dir, 'db.sqlite'));
  await applyMigrations(db, MIGRATIONS_DIR);
  hubs = new DurableObjectNamespaceShim(WorkspaceHub, () => env);
  bridge = createUpgradeBridge();
  app = createApp({ mailer: { sendMagicLink: async () => {} }, now: Date.now });
  const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  server = createServer((_req, res) => res.writeHead(404).end());
  server.on('upgrade', (req, socket, head) => {
    void bridge.handleUpgrade(req, socket, head, toRequest(req), async (r) => {
      const res = await app.fetch(r, env, ctx);
      return wrapResponse ? wrapResponse(res) : res;
    });
  });
  port = await listenLocal(server);
  origin = `http://127.0.0.1:${port}`;
  env = {
    DB: db,
    HUB: hubs as unknown as Env['HUB'],
    BLOB_STORE: createFsBlobStore(join(dir, 'blobs')),
    APP_ORIGIN: origin,
    RESEND_API_KEY: 'dev',
    OWNER_EMAIL: 'owner@test.dev',
    EMAIL_FROM: 'Backroom <noreply@test.dev>',
  } as unknown as Env;
  await addUser(ALICE, 'alice');
  await addUser(BOB, 'bob');
  await addUser(CAROL, 'carol');
});

afterEach(async () => {
  wrapResponse = null;
  for (const c of clients.splice(0)) c.ws.terminate();
  hubs.dispose();
  bridge.close();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  db.close();
  vi.restoreAllMocks();
});

const cid = (p: string, i: number) => `${p}-${i}-xxxxxx`;

/** Waits until `n` acks/nacks arrived on `c` (read from its full frame log, so none is lost to a waiter). */
async function answers(c: Client, n: number) {
  const pick = () => c.frames.filter((f) => f.t === 'ack' || f.t === 'nack');
  await vi.waitFor(() => expect(pick().length).toBeGreaterThanOrEqual(n), { timeout: 5_000 });
  const got = pick();
  return {
    acks: got.filter((f): f is Extract<Frame, { t: 'ack' }> => f.t === 'ack'),
    nacks: got.filter((f): f is Extract<Frame, { t: 'nack' }> => f.t === 'nack').map((f) => ({ clientId: f.clientId, code: f.code })),
  };
}

describe('WorkspaceHub on the Node shim over real WebSockets', () => {
  it('hello over the bridge: catchup with a presence snapshot, and activity announces active to others', async () => {
    const bob = await connect(BOB);
    const alice = await connect(ALICE);
    alice.send({ t: 'hello', lastSeen: {} });
    const c = await alice.next('catchup');
    expect(c.messages).toEqual([]);
    // The snapshot is taken before this hello's own activity is applied (as on Workers).
    expect(c.presence).toEqual(expect.arrayContaining([{ userId: ALICE, state: 'away' }, { userId: BOB, state: 'away' }]));
    expect(await bob.next('presence')).toEqual({ t: 'presence', userId: ALICE, state: 'active' });
    bob.send({ t: 'hello', lastSeen: {} });
    expect((await bob.next('catchup')).presence).toContainEqual({ userId: ALICE, state: 'active' });
    expect(await hub()['ctx'].storage.getAlarm()).not.toBeNull();
  });

  it('send: the sender gets the ack, a second client gets message.new, the sender does not', async () => {
    const alice = await connect(ALICE);
    const bob = await connect(BOB);
    alice.send({ t: 'send', clientId: 'c-1-xxxxxx', channelId: GENERAL, body: 'hello' });
    const ack = await alice.next('ack');
    expect(ack.message).toMatchObject({ body: 'hello', channelId: GENERAL, seq: 1, userId: ALICE });
    expect((await bob.next('message.new')).message.id).toBe(ack.message.id);
    await alice.none('message.new');
    expect(await count('SELECT COUNT(*) AS n FROM messages')).toBe(1);
  });

  it('a duplicate clientId gets the same ack and is stored and broadcast once', async () => {
    const alice = await connect(ALICE);
    const carol = await connect(CAROL);
    const frame = { t: 'send', clientId: 'dup-1-xxxxxx', channelId: GENERAL, body: 'once' } as const;
    alice.send(frame);
    alice.send(frame);
    const a1 = await alice.next('ack');
    const a2 = await alice.next('ack');
    expect(a2.message.id).toBe(a1.message.id);
    await carol.next('message.new');
    await carol.none('message.new');
    expect(await count('SELECT COUNT(*) AS n FROM messages')).toBe(1);
  });

  it('per-socket budget: a burst past 20 is nacked rate_limited; another socket is unaffected', async () => {
    const alice = await connect(ALICE);
    const bob = await connect(BOB);
    hub().now = () => T;
    for (let i = 0; i < 25; i++) alice.send({ t: 'send', clientId: cid('a', i), channelId: GENERAL, body: `a${i}` });
    const a = await answers(alice, 25);
    expect(a.acks).toHaveLength(20);
    expect(a.nacks.map((n) => n.code)).toEqual(Array(5).fill('rate_limited'));
    expect(a.nacks.map((n) => n.clientId).sort()).toEqual([20, 21, 22, 23, 24].map((i) => cid('a', i)).sort());
    bob.send({ t: 'send', clientId: cid('b', 0), channelId: GENERAL, body: 'b0' });
    expect((await bob.next('ack')).clientId).toBe(cid('b', 0));
    expect(await count('SELECT COUNT(*) AS n FROM messages')).toBe(21);
  });

  it('presence goes away through the alarm after the active window', async () => {
    let now = T;
    const bob = await connect(BOB);
    const alice = await connect(ALICE);
    hub().now = () => now;
    alice.send({ t: 'activity' });
    expect(await bob.next('presence')).toEqual({ t: 'presence', userId: ALICE, state: 'active' });
    const at = await hub()['ctx'].storage.getAlarm();
    expect(at).not.toBeNull();
    now = T + ACTIVE_WINDOW_MS - 1;
    expect(await hubs.runAlarm(WS_ID)).toBe(true);
    await bob.none('presence');
    now = T + ACTIVE_WINDOW_MS;
    expect(await hubs.runAlarm(WS_ID)).toBe(true);
    expect(await bob.next('presence')).toEqual({ t: 'presence', userId: ALICE, state: 'away' });
    expect(await hub()['ctx'].storage.getAlarm()).toBeNull();
  });

  it('closing the last socket announces away to the others', async () => {
    const bob = await connect(BOB);
    const alice = await connect(ALICE);
    alice.send({ t: 'activity' });
    await bob.next('presence');
    alice.ws.close(1000, 'bye');
    expect(await alice.closed()).toEqual({ code: 1000, reason: 'bye' });
    expect(await bob.next('presence')).toEqual({ t: 'presence', userId: ALICE, state: 'away' });
    await vi.waitFor(() => expect(hub()['ctx'].getWebSockets(ALICE)).toEqual([]));
  });

  it('ping is answered by the auto-response without reaching the hub', async () => {
    const alice = await connect(ALICE);
    const spy = vi.spyOn(hub(), 'webSocketMessage');
    alice.send(PING_FRAME);
    await alice.next('pong');
    expect(spy).not.toHaveBeenCalled();
    alice.send({ t: 'ping', x: 1 } as unknown as ClientFrame);
    await alice.next('pong');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('disconnectUser (RPC through the stub) closes the user’s sockets with 4001', async () => {
    const alice = await connect(ALICE);
    await (hubs.getByName(WS_ID) as unknown as { disconnectUser(id: string): Promise<void> }).disconnectUser(ALICE);
    expect(await alice.closed()).toEqual({ code: 4001, reason: 'deactivated' });
  });

  it('a member deactivated during connect is closed with 4001 right after the upgrade', async () => {
    // The route admits the session; the deactivation commits before the hub's own membership read,
    // so the hub closes the socket before its 101 response has even been sent (buffered close).
    hub().beforeChannelRead = async () => {
      await db.prepare('UPDATE workspace_members SET deactivated_at = 1 WHERE user_id = ?').bind(ALICE).run();
    };
    const alice = await connect(ALICE);
    expect(await alice.closed()).toEqual({ code: 4001, reason: 'deactivated' });
    await vi.waitFor(() => expect(hub()['ctx'].getWebSockets()).toEqual([]));
  });

  it('a rejected upgrade is answered as plain HTTP with the app’s JSON error, and no socket is accepted', async () => {
    const ws = openSocket({ Origin: origin });
    const res = await new Promise<IncomingMessage>((resolve) => ws.once('unexpected-response', (_q, r) => resolve(r)));
    expect(res.statusCode).toBe(401);
    let body = '';
    for await (const chunk of res) body += chunk;
    expect(JSON.parse(body)).toEqual({ error: { code: 'unauthenticated', message: 'Sign in required.' } });
    expect(hubs.has(WS_ID)).toBe(false);
  });

  it('a plain request to /ws with an Upgrade header but no real upgrade gets a clean 426, not a 500', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
    const res = await app.fetch(
      new Request(`${origin}/ws?workspace=clubhack`, {
        headers: { Upgrade: 'websocket', Cookie: `backroom_session=${tokens.get(ALICE)}`, Origin: origin },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(426);
    expect(await res.json()).toEqual({ error: { code: 'upgrade_required', message: 'WebSocket upgrade required.' } });
    expect(logged).not.toHaveBeenCalled();
  });

  it('a malformed handshake is refused with 400 before the app runs', async () => {
    const { connect: netConnect } = await import('node:net');
    const sock = netConnect(port, '127.0.0.1');
    let reply = '';
    sock.on('data', (d) => (reply += d.toString()));
    await new Promise<void>((r) => sock.once('connect', () => r()));
    sock.write(
      `GET /ws?workspace=clubhack HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Cookie: backroom_session=${tokens.get(ALICE)}\r\nOrigin: ${origin}\r\n\r\n`,
    );
    await new Promise<void>((r) => sock.once('close', () => r()));
    expect(reply.startsWith('HTTP/1.1 400')).toBe(true);
    expect(hubs.has(WS_ID)).toBe(false);
  });

  it('a bad Origin is refused with 403 before the hub', async () => {
    const ws = openSocket({ Cookie: `backroom_session=${tokens.get(ALICE)}`, Origin: 'https://evil.test' });
    const status = await new Promise<number>((resolve) => ws.once('unexpected-response', (_q, res) => resolve(res.statusCode ?? 0)));
    expect(status).toBe(403);
  });

  it('the upgrade survives a copied response (as Hono makes), and its headers reach the 101 handshake', async () => {
    wrapResponse = (r) => {
      const copy = new Response(r.body, r);
      copy.headers.set('x-extra', 'kept');
      return copy;
    };
    const ws = openSocket({ Cookie: `backroom_session=${tokens.get(ALICE)}`, Origin: origin });
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      ws.once('upgrade', resolve);
      ws.once('unexpected-response', () => reject(new Error('upgrade refused')));
    });
    const c = new Client(ws);
    clients.push(c);
    expect(res.statusCode).toBe(101);
    expect(res.headers['x-extra']).toBe('kept');
    expect(Object.keys(res.headers).some((k) => k.startsWith('x-backroom'))).toBe(false);
    c.send(PING_FRAME);
    await c.next('pong');
  });

  it('a forged marker header from outside the hub does not upgrade', async () => {
    wrapResponse = () => new Response('nope', { status: 200, headers: { 'x-backroom-ws-upgrade': 'guess' } });
    const ws = openSocket({ Cookie: `backroom_session=${tokens.get(ALICE)}`, Origin: origin });
    const res = await new Promise<IncomingMessage>((resolve) => ws.once('unexpected-response', (_q, r) => resolve(r)));
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-backroom-ws-upgrade']).toBeUndefined();
    // The pair the hub created for this request was abandoned, so it is not left in the hub.
    await vi.waitFor(() => expect(hub()['ctx'].getWebSockets()).toEqual([]));
  });

  it('an oversized or binary frame closes only that socket; the process and other sockets carry on', async () => {
    const alice = await connect(ALICE);
    const bob = await connect(BOB);
    alice.ws.send(Buffer.from([1, 2, 3]));
    expect((await alice.closed()).code).toBe(1009);
    bob.send({ t: 'send', clientId: 'c-2-xxxxxx', channelId: GENERAL, body: 'still here' });
    expect((await bob.next('ack')).message.body).toBe('still here');
  });

  it('logs nothing that contains a message body', async () => {
    const logs: string[] = [];
    for (const m of ['log', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
    }
    const alice = await connect(ALICE);
    const bob = await connect(BOB);
    alice.send({ t: 'send', clientId: 'c-3-xxxxxx', channelId: GENERAL, body: 'top secret body' });
    await alice.next('ack');
    await bob.next('message.new');
    bob.ws.terminate();
    alice.send({ t: 'send', clientId: 'c-4-xxxxxx', channelId: GENERAL, body: 'top secret body 2' });
    await alice.next('ack');
    expect(logs.join('\n')).not.toContain('top secret');
  });
});
