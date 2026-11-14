import { type Server, createServer } from 'node:http';
import { type Socket, connect as netConnect } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DurableObject, DurableObjectNamespaceShim } from '../src/platform/do-runtime';
import { type UpgradeBridge, createUpgradeBridge, pairForCurrentUpgrade, responseForCurrentUpgrade } from '../src/platform/ws-bridge';
import { listenLocal } from './helpers';

class Recorder extends DurableObject<unknown> {
  closes: number[] = [];
  accept(ws: WebSocket): void {
    this.ctx.acceptWebSocket(ws);
  }
  sockets(): WebSocket[] {
    return this.ctx.getWebSockets();
  }
  webSocketClose(_ws: WebSocket, code: number): void {
    this.closes.push(code);
  }
}

let server: Server;
let port: number;
let bridge: UpgradeBridge;
let handler: (r: Request) => Promise<Response> | Response;
let ns: DurableObjectNamespaceShim<Recorder>;
const raw: Socket[] = [];

async function start(opts: Parameters<typeof createUpgradeBridge>[0]): Promise<void> {
  bridge = createUpgradeBridge(opts);
  server = createServer((_q, s) => s.writeHead(404).end());
  server.on('upgrade', (req, socket, head) => {
    void bridge.handleUpgrade(req, socket, head, new Request(`http://127.0.0.1${req.url}`, { headers: { upgrade: 'websocket' } }), (r) =>
      handler(r),
    );
  });
  port = await listenLocal(server);
}

const connections = () => new Promise<number>((r) => server.getConnections((_e, n) => r(n)));

/** A raw client that never sends FIN on its own (allowHalfOpen), so only the server can finish the connection. */
async function halfOpenClient(request: string): Promise<{ sock: Socket; reply: () => string }> {
  const sock = netConnect({ port, host: '127.0.0.1', allowHalfOpen: true });
  raw.push(sock);
  let data = '';
  sock.on('data', (d) => (data += d.toString()));
  sock.on('error', () => {});
  await new Promise<void>((r) => sock.once('connect', () => r()));
  sock.write(request);
  return { sock, reply: () => data };
}

const handshake = (extra = '') =>
  `GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
  `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`;

beforeEach(() => {
  ns = new DurableObjectNamespaceShim(Recorder, () => ({}));
  handler = () => Response.json({ error: { code: 'unauthenticated', message: 'Sign in required.' } }, { status: 401 });
});

afterEach(async () => {
  for (const s of raw.splice(0)) s.destroy();
  ns.dispose();
  bridge.close();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  vi.restoreAllMocks();
});

describe('upgrade bridge: rejected upgrades never hold a socket', () => {
  it('a refused upgrade is answered and the server socket destroyed, even if the client never closes its side', async () => {
    await start({});
    const { reply } = await halfOpenClient(handshake());
    await vi.waitFor(() => expect(reply()).toContain('HTTP/1.1 401'));
    await vi.waitFor(() => expect(connections()).resolves.toBe(0), { timeout: 2_000 });
  });

  it('a malformed handshake (400) is destroyed the same way', async () => {
    await start({});
    const { reply } = await halfOpenClient('GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    await vi.waitFor(() => expect(reply()).toContain('HTTP/1.1 400'));
    await vi.waitFor(() => expect(connections()).resolves.toBe(0), { timeout: 2_000 });
  });

  it('a client that never reads its reply is destroyed by the linger timer', async () => {
    await start({ rejectLingerMs: 100 });
    // A large refusal body the paused client never reads, so the write cannot finish on its own.
    handler = () => new Response('x'.repeat(16 * 1024 * 1024), { status: 403 });
    const { sock } = await halfOpenClient(handshake());
    sock.pause();
    await vi.waitFor(() => expect(connections()).resolves.toBe(0), { timeout: 3_000 });
  });

  it('a fetch handler that hangs past the deadline gets a 503 and the socket is destroyed', async () => {
    await start({ upgradeDeadlineMs: 100 });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    handler = () => new Promise<Response>(() => {});
    const t0 = Date.now();
    const { reply } = await halfOpenClient(handshake());
    await vi.waitFor(() => expect(reply()).toContain('HTTP/1.1 503'), { timeout: 2_000 });
    expect(Date.now() - t0).toBeLessThan(1_500);
    await vi.waitFor(() => expect(connections()).resolves.toBe(0), { timeout: 2_000 });
  });

  it('a pair the hub creates after the deadline is abandoned once the handler finishes', async () => {
    await start({ upgradeDeadlineMs: 50 });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const hub = ns.instance('w');
    handler = async () => {
      await new Promise((r) => setTimeout(r, 150));
      const pair = pairForCurrentUpgrade();
      hub.accept(pair[1]);
      return responseForCurrentUpgrade(pair[0]);
    };
    const { reply } = await halfOpenClient(handshake());
    await vi.waitFor(() => expect(reply()).toContain('HTTP/1.1 503'), { timeout: 2_000 });
    await vi.waitFor(() => expect(hub.closes).toEqual([1006]), { timeout: 2_000 });
    expect(hub.sockets()).toEqual([]);
  });

  it('a handler that answers in time still upgrades', async () => {
    await start({ upgradeDeadlineMs: 1_000 });
    const hub = ns.instance('w');
    handler = () => {
      const pair = pairForCurrentUpgrade();
      hub.accept(pair[1]);
      return responseForCurrentUpgrade(pair[0]);
    };
    const { reply } = await halfOpenClient(handshake());
    await vi.waitFor(() => expect(reply()).toContain('HTTP/1.1 101'));
    expect(hub.sockets().length).toBe(1);
  });
});
