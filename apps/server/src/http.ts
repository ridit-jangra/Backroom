/**
 * The HTTP layer: routes each request to the app or the static site, applies the trusted client IP and the body
 * size limit, runs HEAD as GET with the body cancelled, and hands WebSocket upgrades to the bridge.
 */
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { getRequestListener } from '@hono/node-server';
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
        if (Number(declared) > deps.maxBodyBytes) return json(413, 'too_large', 'The request body is too large.');
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
  return new Request(appOrigin + path, { method: req.method ?? 'GET', headers });
}

export interface HttpServerDeps {
  handler: (req: Request) => Promise<Response>;
  /** Runs the app for an upgrade (no static routing: only the app answers WebSockets). */
  upgradeHandler: (req: Request) => Promise<Response>;
  bridge: UpgradeBridge;
  appOrigin: string;
  trustedProxyHeader: string | null;
  log: Log;
}

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

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    applyClientIp(req, deps.trustedProxyHeader);
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
    void listener(req, res);
  });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    applyClientIp(req, deps.trustedProxyHeader);
    upgraded.add(socket);
    socket.once('close', () => upgraded.delete(socket));
    void deps.bridge.handleUpgrade(req, socket, head, upgradeRequest(req, deps.appOrigin), deps.upgradeHandler);
  });

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
