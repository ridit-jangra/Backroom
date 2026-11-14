/**
 * The HTTP layer: routes each request to the app or the static site, applies the trusted client IP and the body
 * size limit, runs HEAD as GET with the body cancelled, and hands WebSocket upgrades to the bridge.
 */
import { type IncomingMessage, STATUS_CODES, type Server, type ServerResponse, createServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { getRequestListener } from '@hono/node-server';
import { megabytes } from '../../worker/src/lib/quota';
import { applyClientIp } from './client-ip';
import { type Log, errorFields } from './log';
import type { UpgradeBridge } from './platform/ws-bridge';
import { type StaticSite, isApiPath, isNavigationRequest } from './static';

export interface AppLike {
  fetch(req: Request, env: never, ctx: ExecutionContext): Response | Promise<Response>;
}

export interface HandlerDeps {
  app: AppLike;
  env: unknown;
  ctx: ExecutionContext;
  site: StaticSite;
  /** Throws when the database is unusable (the /health probe). */
  checkDb(): unknown;
  /** Largest request body accepted (the upload limit). */
  maxBodyBytes: number;
  log: Log;
}

const json = (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status });

/** A body stream that errors once more than `max` bytes went through (for bodies without a Content-Length). */
function cappedBody(body: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctrl) {
        seen += chunk.byteLength;
        if (seen > max) ctrl.error(new RangeError('request body too large'));
        else ctrl.enqueue(chunk);
      },
    }),
  );
}

export function createRequestHandler(deps: HandlerDeps): (req: Request) => Promise<Response> {
  const { app, env, ctx, site, log } = deps;
  const appFetch = (r: Request) => Promise.resolve(app.fetch(r, env as never, ctx));

  /** HEAD runs the GET route (as Hono would), but here the GET body is cancelled instead of dropped. */
  async function callApp(req: Request): Promise<Response> {
    if (req.method !== 'HEAD') return appFetch(req);
    const res = await appFetch(new Request(req.url, { method: 'GET', headers: req.headers, signal: req.signal }));
    await res.body?.cancel().catch(() => {});
    return new Response(null, { status: res.status, statusText: res.statusText, headers: res.headers });
  }

  return async (req) => {
    const pathname = new URL(req.url).pathname;

    if (req.body !== null) {
      const declared = req.headers.get('content-length');
      if (declared !== null) {
        if (Number(declared) > deps.maxBodyBytes) {
          // The upload route's own wording; the connection is closed rather than reading a body we refuse.
          const res = json(413, 'too_large', `Files must be ${megabytes(deps.maxBodyBytes)} or smaller.`);
          res.headers.set('connection', 'close');
          return res;
        }
      } else {
        req = new Request(req.url, {
          method: req.method,
          headers: req.headers,
          body: cappedBody(req.body, deps.maxBodyBytes),
          signal: req.signal,
          duplex: 'half',
        } as RequestInit);
      }
    }

    if (isApiPath(pathname)) {
      if (pathname === '/health' && (req.method === 'GET' || req.method === 'HEAD')) {
        try {
          deps.checkDb();
        } catch (e) {
          log('error', 'health_db_failed', errorFields(e));
          return json(503, 'unavailable', 'Service unavailable.');
        }
      }
      return callApp(req);
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const file = await site.serve(req);
      if (file) return file;
      if (isNavigationRequest(req)) return site.index(req);
    }
    return callApp(req);
  };
}

/** Methods the fetch API can represent (it refuses CONNECT, TRACE and TRACK) and the app may answer. */
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

/**
 * Puts the request line and Host into a shape nothing downstream can choke on: an absolute-form target becomes its
 * path, and Host is replaced by APP_ORIGIN's host (the app never routes on Host; a forged or malformed one must
 * not reach URL parsing). Returns false for targets that are not a path at all (`*`, authority-form, garbage).
 */
export function normalizeTarget(req: IncomingMessage, appHost: string): boolean {
  let target = req.url ?? '';
  if (!target.startsWith('/')) {
    if (!/^https?:\/\//i.test(target)) return false;
    try {
      const u = new URL(target);
      target = u.pathname + u.search;
    } catch {
      return false;
    }
  }
  if (target.startsWith('//')) target = `/${target.replace(/^\/+/, '')}`;
  try {
    // Parsing must succeed on the host the app will see.
    new URL(`http://${appHost}${target}`);
  } catch {
    return false;
  }
  req.url = target;
  const headers = req.headers; // materialised before rawHeaders changes (see applyClientIp)
  const raw: string[] = [];
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i]!.toLowerCase() !== 'host') raw.push(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
  }
  raw.unshift('Host', appHost);
  req.rawHeaders = raw;
  headers.host = appHost;
  return true;
}

/** The app's view of an upgrade request (a GET without a body); the URL is built on APP_ORIGIN, never on Host. */
export function upgradeRequest(req: IncomingMessage, appOrigin: string): Request {
  const headers = new Headers();
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    try {
      headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
    } catch {
      // a header the fetch API refuses is simply not passed on
    }
  }
  const path = req.url?.startsWith('/') ? req.url : '/';
  return new Request(appOrigin + path, { method: 'GET', headers });
}

/** A plain error reply on a raw (upgrade) socket, then the socket is destroyed once flushed. */
function refuseSocket(socket: Duplex, status: number, reason: string): void {
  try {
    if (socket.writable) {
      const body = JSON.stringify({ error: { code: status === 405 ? 'method_not_allowed' : 'invalid_request', message: reason } });
      socket.end(
        `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
      );
      socket.once('finish', () => socket.destroy());
      setTimeout(() => socket.destroy(), 2_000).unref();
    } else socket.destroy();
  } catch {
    socket.destroy();
  }
}

function refuseResponse(res: ServerResponse, status: number, code: string, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify({ error: { code, message } });
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), connection: 'close' });
  res.end(body);
}

export interface HttpServerDeps {
  handler: (req: Request) => Promise<Response>;
  /** Runs the app for an upgrade (no static routing: only the app answers WebSockets). */
  upgradeHandler: (req: Request) => Promise<Response>;
  bridge: UpgradeBridge;
  appOrigin: string;
  trustedProxyHeader: string | null;
  trustedProxySecret: string | null;
  keepAliveTimeoutMs: number;
  maxConnections: number;
  log: Log;
}

/** A whole request (a 25 MB upload on a slow link included) must arrive within this. */
export const REQUEST_TIMEOUT_MS = 15 * 60_000;
/** The request line and headers must arrive within this (below REQUEST_TIMEOUT_MS). */
export const HEADERS_TIMEOUT_MS = 60_000;

export interface HttpServer {
  server: Server;
  /** Sockets handed to the WebSocket bridge (open until their connection ends). */
  upgraded: Set<Duplex>;
  /** Requests whose response has not finished yet. */
  inFlight(): number;
  /** Resolves when no request is in flight. */
  idle(): Promise<void>;
}

export function createHttpServer(deps: HttpServerDeps): HttpServer {
  const { log } = deps;
  const listener = getRequestListener((req) => deps.handler(req), {
    // Keep the platform's own Request/Response (the bridge and the app rely on them).
    overrideGlobalObjects: false,
    errorHandler: (e) => {
      log('error', 'request_failed', errorFields(e));
      return json(500, 'internal', 'Internal error.');
    },
  });

  let active = 0;
  const idleWaiters: (() => void)[] = [];
  const upgraded = new Set<Duplex>();

  const appHost = new URL(deps.appOrigin).host;

  // Nothing thrown while handling one request may escape these listeners: an uncaught exception stops the server.
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    active++;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      active--;
      if (active === 0) for (const w of idleWaiters.splice(0)) w();
    };
    res.once('close', finish);
    res.once('finish', finish);
    res.once('finish', () => {
      // A refusal (e.g. the 413 above) that leaves the body unread: stop reading it and drop the connection.
      if (!req.complete && String(res.getHeader('connection')).toLowerCase() === 'close') {
        req.socket.end();
        setTimeout(() => req.socket.destroy(), 1_000).unref();
      }
    });
    res.on('error', () => {});
    try {
      if (!METHODS.has(req.method ?? '')) {
        res.setHeader('allow', [...METHODS].join(', '));
        refuseResponse(res, 405, 'method_not_allowed', 'Method not allowed.');
        return;
      }
      if (!normalizeTarget(req, appHost)) {
        refuseResponse(res, 400, 'invalid_request', 'Bad request target.');
        return;
      }
      applyClientIp(req, deps.trustedProxyHeader, deps.trustedProxySecret);
      listener(req, res).catch((e: unknown) => {
        log('error', 'request_failed', errorFields(e));
        refuseResponse(res, 500, 'internal', 'Internal error.');
      });
    } catch (e) {
      log('warn', 'request_rejected', errorFields(e));
      refuseResponse(res, 400, 'invalid_request', 'Bad request.');
    }
  });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => {});
    try {
      if (req.method !== 'GET') return refuseSocket(socket, 405, 'Method not allowed.');
      if (!normalizeTarget(req, appHost)) return refuseSocket(socket, 400, 'Bad request target.');
      applyClientIp(req, deps.trustedProxyHeader, deps.trustedProxySecret);
      const request = upgradeRequest(req, deps.appOrigin);
      upgraded.add(socket);
      socket.once('close', () => upgraded.delete(socket));
      deps.bridge.handleUpgrade(req, socket, head, request, deps.upgradeHandler).catch((e: unknown) => {
        log('error', 'ws_upgrade_failed', errorFields(e));
        socket.destroy();
      });
    } catch (e) {
      log('warn', 'upgrade_rejected', errorFields(e));
      refuseSocket(socket, 400, 'Bad request.');
    }
  });

  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  // Longer than the reverse proxy's idle timeout, so the proxy never reuses a connection we are closing.
  server.keepAliveTimeout = deps.keepAliveTimeoutMs;
  server.maxConnections = deps.maxConnections;

  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
    else socket.destroy();
  });

  return {
    server,
    upgraded,
    inFlight: () => active,
    idle: () => (active === 0 ? Promise.resolve() : new Promise<void>((r) => idleWaiters.push(r))),
  };
}
