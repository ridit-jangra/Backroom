/**
 * WebSocket upgrade bridge: serves a Node HTTP `upgrade` event through the app's fetch handler, the way workerd
 * serves a WebSocket request, and joins the `ws` connection to the hub's socket.
 *
 * 1. The handshake headers are checked (400 otherwise; the app never runs).
 * 2. The fetch handler runs inside an upgrade context (AsyncLocalStorage). The hub's `newWebSocketPair()` and
 *    `upgradeResponse()` (hub-platform.ts, which replaces apps/worker/src/hub/platform.ts on Node) register the
 *    pair in that context. Node's `Response` cannot carry status 101, so the hub's upgrade response is a 200 with
 *    a private marker header holding this request's random token; Hono may copy the response (it does when a
 *    middleware set a header first), and the header survives the copy.
 * 3. If the final response carries the marker, `ws` completes the handshake (101, with the app's headers, e.g. a
 *    renewed session cookie, minus the marker) and the connection is attached to the hub's socket, which then
 *    delivers any frames or close the hub issued meanwhile. Any other response is written as a plain HTTP
 *    response (the app's JSON error, e.g. 401 or 403) and the connection is closed.
 * 4. A pair whose connection never arrives (another response won, the handshake failed, the client left first)
 *    is abandoned: the hub sees an abnormal close (1006) if it had accepted the socket and not closed it itself.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { type IncomingMessage, STATUS_CODES } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { type NodeWebSocket, NodeWebSocketClientEnd, abandonSocket, attachRawSocket, createWebSocketPair } from './do-runtime';

/** Private marker on the hub's upgrade response; never sent to a client. */
export const UPGRADE_MARKER_HEADER = 'x-backroom-ws-upgrade';
/** Largest incoming message, the same as workerd's 1 MiB (the hub itself refuses frames over 256 KiB chars). */
export const DEFAULT_MAX_PAYLOAD = 1024 * 1024;
/** How long the app may take to answer an upgrade before the client gets a 503 (no server timeout covers it). */
export const DEFAULT_UPGRADE_DEADLINE_MS = 10_000;
/** How long a refused upgrade's socket may linger (a client not reading its reply) before it is destroyed. */
export const DEFAULT_REJECT_LINGER_MS = 5_000;

type UpgradeContext = { token: string; servers: NodeWebSocket[]; chosen: NodeWebSocket | null };

const upgrades = new AsyncLocalStorage<UpgradeContext>();

/** `new WebSocketPair()` on Node: only valid while the bridge is serving an upgrade request. */
export function pairForCurrentUpgrade(): { 0: WebSocket; 1: WebSocket } {
  const ctx = upgrades.getStore();
  if (!ctx) throw new Error('A WebSocketPair can only be created while serving a WebSocket upgrade request.');
  const pair = createWebSocketPair();
  ctx.servers.push(pair[1] as unknown as NodeWebSocket);
  return pair;
}

/** The hub's upgrade response on Node (see the module comment). */
export function responseForCurrentUpgrade(client: WebSocket): Response {
  const ctx = upgrades.getStore();
  const c = client as unknown;
  if (!ctx || !(c instanceof NodeWebSocketClientEnd) || !ctx.servers.includes(c.server)) {
    throw new TypeError('upgradeResponse() needs the client end of a pair created for this upgrade request.');
  }
  ctx.chosen = c.server;
  return new Response(null, { status: 200, headers: { [UPGRADE_MARKER_HEADER]: ctx.token } });
}

export interface UpgradeBridge {
  /**
   * Call from the HTTP server's `upgrade` event. `request` is the app's view of the same request (the caller
   * builds it, with its trusted client IP rules); `fetchHandler` runs the app (e.g. `r => app.fetch(r, env, ctx)`).
   * Never rejects.
   */
  handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    request: Request,
    fetchHandler: (request: Request) => Promise<Response> | Response,
  ): Promise<void>;
  /** Terminates connections still open (call after the hub namespace's `closeAll(1001, …)` had its chance). */
  close(): void;
}

const KEY_RE = /^[+/0-9A-Za-z]{22}==$/;

function validHandshake(req: IncomingMessage): boolean {
  return (
    req.method === 'GET' &&
    req.headers.upgrade?.toLowerCase() === 'websocket' &&
    KEY_RE.test(req.headers['sec-websocket-key'] ?? '') &&
    req.headers['sec-websocket-version'] === '13'
  );
}

/** Headers never copied from the app's response onto the wire. */
const SKIP = new Set([UPGRADE_MARKER_HEADER, 'connection', 'upgrade', 'content-length', 'transfer-encoding', 'keep-alive', 'set-cookie']);

function appHeaderLines(res: Response, upgrading: boolean): string[] {
  const lines: string[] = [];
  res.headers.forEach((value, name) => {
    if (SKIP.has(name) || (upgrading && (name.startsWith('sec-websocket-') || name === 'content-type'))) return;
    lines.push(`${name}: ${value}`);
  });
  for (const c of res.headers.getSetCookie()) lines.push(`set-cookie: ${c}`);
  return lines;
}

/**
 * Writes a plain HTTP response and gets rid of the socket. After the `upgrade` event Node applies no timeout and
 * its sockets allow half-open, so `end()` alone would leave the connection (and its fd) to the client. Like ws's
 * own abortHandshake, the socket is destroyed once the reply is flushed, or after `lingerMs` if it never is.
 */
async function writeHttpResponse(socket: Duplex, res: Response, lingerMs: number): Promise<void> {
  let body: Buffer;
  try {
    body = Buffer.from(await res.arrayBuffer());
  } catch {
    body = Buffer.alloc(0);
  }
  if (socket.destroyed) return;
  const head = [
    `HTTP/1.1 ${res.status} ${STATUS_CODES[res.status] ?? ''}`,
    ...appHeaderLines(res, false),
    `content-length: ${body.byteLength}`,
    'connection: close',
  ];
  const timer = setTimeout(() => socket.destroy(), lingerMs);
  timer.unref();
  socket.once('close', () => clearTimeout(timer));
  socket.once('finish', () => socket.destroy());
  socket.end(Buffer.concat([Buffer.from(`${head.join('\r\n')}\r\n\r\n`, 'latin1'), body]));
}

export function createUpgradeBridge(
  opts: { maxPayload?: number; upgradeDeadlineMs?: number; rejectLingerMs?: number } = {},
): UpgradeBridge {
  const deadlineMs = opts.upgradeDeadlineMs ?? DEFAULT_UPGRADE_DEADLINE_MS;
  const lingerMs = opts.rejectLingerMs ?? DEFAULT_REJECT_LINGER_MS;
  const wss = new WebSocketServer({ noServer: true, maxPayload: opts.maxPayload ?? DEFAULT_MAX_PAYLOAD });
  const extraHeaders = new WeakMap<IncomingMessage, string[]>();
  wss.on('headers', (headers: string[], req: IncomingMessage) => {
    const extra = extraHeaders.get(req);
    if (extra) headers.push(...extra);
    extraHeaders.delete(req);
  });
  // The server's own errors (none expected in noServer mode) must never be unhandled.
  wss.on('error', () => {});

  return {
    async handleUpgrade(req, socket, head, request, fetchHandler) {
      // A reset before ws takes over must not become an unhandled 'error' event.
      socket.on('error', () => {});
      if (!validHandshake(req)) {
        await writeHttpResponse(socket, new Response('Bad WebSocket handshake.', { status: 400 }), lingerMs);
        return;
      }
      const ctx: UpgradeContext = { token: randomUUID(), servers: [], chosen: null };
      const abandonAll = () => {
        for (const s of ctx.servers) abandonSocket(s as unknown as WebSocket);
      };
      const run = Promise.resolve().then(() => upgrades.run(ctx, () => fetchHandler(request)));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<'late'>((resolve) => {
        timer = setTimeout(() => resolve('late'), deadlineMs);
      });
      let res: Response;
      try {
        const outcome = await Promise.race([run, late]);
        if (outcome === 'late') {
          console.error(JSON.stringify({ level: 'error', code: 'ws_upgrade_timeout' }));
          // Whatever the handler still creates is never connected.
          void run.then(abandonAll, abandonAll);
          await writeHttpResponse(
            socket,
            Response.json({ error: { code: 'unavailable', message: 'Service unavailable.' } }, { status: 503 }),
            lingerMs,
          );
          return;
        }
        res = outcome;
      } catch {
        console.error(JSON.stringify({ level: 'error', code: 'ws_upgrade_failed' }));
        res = Response.json({ error: { code: 'internal', message: 'Internal error.' } }, { status: 500 });
      } finally {
        clearTimeout(timer);
      }
      const chosen = ctx.chosen !== null && res.headers.get(UPGRADE_MARKER_HEADER) === ctx.token ? ctx.chosen : null;
      for (const s of ctx.servers) if (s !== chosen) abandonSocket(s as unknown as WebSocket);
      if (!chosen) {
        await writeHttpResponse(socket, res, lingerMs);
        return;
      }
      const server = chosen as unknown as WebSocket;
      if (socket.destroyed || !socket.writable) {
        abandonSocket(server);
        return;
      }
      let joined = false;
      const onGone = () => {
        if (!joined) abandonSocket(server);
      };
      socket.once('close', onGone);
      extraHeaders.set(req, appHeaderLines(res, true));
      wss.handleUpgrade(req, socket, head, (ws) => {
        joined = true;
        socket.off('close', onGone);
        attachRawSocket(server, ws);
      });
    },
    close() {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}
