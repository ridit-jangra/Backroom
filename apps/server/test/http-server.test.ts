import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { type HttpServer, createHttpServer } from '../src/http';
import type { UpgradeBridge } from '../src/platform/ws-bridge';
import { listenLocal } from './helpers';

let http: HttpServer | null = null;
afterEach(async () => {
  if (!http) return;
  http.server.closeAllConnections();
  await new Promise<void>((r) => http!.server.close(() => r()));
  http = null;
});

const bridge = { handleUpgrade: async () => {}, close() {} } as unknown as UpgradeBridge;

function make(opts: { keepAliveTimeoutMs?: number; maxConnections?: number } = {}) {
  return createHttpServer({
    handler: async () => new Response('ok'),
    upgradeHandler: async () => new Response(null, { status: 404 }),
    bridge,
    appOrigin: 'http://localhost:8900',
    trustedProxyHeader: null,
    trustedProxySecret: null,
    keepAliveTimeoutMs: opts.keepAliveTimeoutMs ?? 190_000,
    maxConnections: opts.maxConnections ?? 2048,
    log: () => {},
  });
}

describe('createHttpServer timeouts and limits', () => {
  it('sets explicit request, header and keep-alive timeouts and the connection cap', () => {
    http = make({ keepAliveTimeoutMs: 123_000, maxConnections: 77 });
    expect(http.server.requestTimeout).toBe(15 * 60_000);
    expect(http.server.headersTimeout).toBe(60_000);
    expect(http.server.headersTimeout).toBeLessThan(http.server.requestTimeout);
    expect(http.server.keepAliveTimeout).toBe(123_000);
    expect(http.server.maxConnections).toBe(77);
  });

  it('connections over the cap are dropped while the others keep working', async () => {
    http = make({ maxConnections: 2 });
    const port = await listenLocal(http.server);
    const open = () =>
      new Promise<{ closed: Promise<void> }>((resolve) => {
        const s = connect(port, '127.0.0.1', () => resolve({ closed: new Promise((r) => s.on('close', () => r())) }));
        s.on('error', () => {});
      });
    const a = await open();
    const b = await open();
    const c = await open();
    await c.closed; // the third is closed by the server
    let aClosed = false;
    void a.closed.then(() => (aClosed = true));
    void b.closed;
    await new Promise((r) => setTimeout(r, 100));
    expect(aClosed).toBe(false);
  });
});
