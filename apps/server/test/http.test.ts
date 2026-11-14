import { join } from 'node:path';
import { FILE_MAX_BYTES, FILES_QUOTA_BYTES } from '@backroom/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../worker/src/app';
import { consoleMailer } from '../../worker/src/auth/mailer';
import { createSession } from '../../worker/src/auth/sessions';
import type { Env } from '../../worker/src/env';
import { fileMaxBytes, filesQuotaBytes } from '../../worker/src/lib/quota';
import { type AppLike, createRequestHandler } from '../src/http';
import { createWorkTracker } from '../src/work';
import { type NodeD1Database, createD1 } from '../src/platform/d1';
import { createFsBlobStore } from '../src/platform/fs-blobs';
import { installFixedLengthStream } from '../src/platform/fixed-length-stream';
import { applyMigrations } from '../src/platform/migrate';
import { createStaticSite } from '../src/static';
import { MIGRATIONS_DIR, fixtureDist, tempDir } from './helpers';

const ORIGIN = 'http://localhost:8790';
const WS_ID = '01JCLUBHACK0000000000000WS';
const ALICE = '01JALICE000000000000000000';

let db: NodeD1Database;
let env: Env;
let handler: (r: Request) => Promise<Response>;
let token: string;
const work = createWorkTracker(() => {});

installFixedLengthStream();

async function setup(extraEnv: Partial<Env> = {}, app?: AppLike, maxBodyBytes?: number) {
  const dir = tempDir();
  db = createD1(join(dir, 'db.sqlite'));
  await applyMigrations(db, MIGRATIONS_DIR);
  env = {
    DB: db,
    BLOB_STORE: createFsBlobStore(join(dir, 'blobs')),
    APP_ORIGIN: ORIGIN,
    RESEND_API_KEY: 'dev',
    OWNER_EMAIL: 'owner@test.local',
    EMAIL_FROM: 'Backroom <noreply@localhost>',
    ...extraEnv,
  } as unknown as Env;
  handler = createRequestHandler({
    app: app ?? createApp({ mailer: consoleMailer, now: Date.now }),
    env,
    ctx: work.ctx,
    site: await createStaticSite(fixtureDist()),
    checkDb: () => void db.sqlite.prepare('SELECT 1').get(),
    // The production limit: the upload limit the worker itself enforces (env override or the protocol constant).
    maxBodyBytes: maxBodyBytes ?? fileMaxBytes(env),
    log: () => {},
  });
  await db.batch([
    db.prepare("INSERT INTO users (id, email, display_name, created_at) VALUES (?, 'alice@test.local', 'alice', 0)").bind(ALICE),
    db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'member', 0)").bind(WS_ID, ALICE),
  ]);
  token = await createSession(db, ALICE, null, Date.now());
}

afterEach(() => {
  db?.close();
});

const get = (path: string, headers: Record<string, string> = {}, method = 'GET') => handler(new Request(`${ORIGIN}${path}`, { method, headers }));
const NAV = { 'Sec-Fetch-Mode': 'navigate', Accept: 'text/html' };

describe('routing between the app and the static site', () => {
  beforeEach(() => setup());

  it('static files and the SPA shell for navigations to non-API paths', async () => {
    const js = await get('/assets/index-AbC123xy.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    const shell = await get('/client/clubhack', NAV);
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain('<div id="root">');
    const verify = await get('/verify?t=abc', { Accept: 'text/html,application/xhtml+xml' });
    expect(await verify.text()).toContain('<div id="root">');
  });

  it('API paths always reach the app: unknown ones are JSON 404s, even for a navigation', async () => {
    for (const p of ['/w/clubhack/nope', '/files/nope/x/y', '/auth/nope', '/channels/x/nope']) {
      const r = await get(p, NAV);
      expect(r.status, p).toBe(404);
      expect(r.headers.get('content-type'), p).toMatch(/application\/json/);
      expect(await r.json(), p).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
    }
  });

  it('non-navigation misses are JSON 404s from the app, not index.html', async () => {
    const r = await get('/nope.js', { Accept: '*/*' });
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
  });

  it('a POST to a static path goes to the app', async () => {
    const r = await handler(new Request(`${ORIGIN}/index.html`, { method: 'POST', headers: { Origin: ORIGIN } }));
    expect(r.status).toBe(404);
  });

  it.each(['/..%2f..%2fetc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '/a%00b', '/%252e%252e/%252e%252e/etc/passwd', '/assets/..%5c..%5c_headers'])(
    'traversal %s never escapes the web root',
    async (p) => {
      for (const headers of [NAV, { Accept: '*/*' }]) {
        const r = await get(p, headers);
        const text = await r.text();
        expect(text).not.toMatch(/root:|nosniff/);
        if (r.status === 200) expect(text).toContain('<div id="root">');
        else expect(r.status).toBe(404);
      }
    },
  );

  it('/health is the app answer {"ok":true}', async () => {
    const r = await get('/health');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it('a request with a session reaches authenticated routes', async () => {
    const r = await get('/me', { Cookie: `backroom_session=${token}` });
    expect(r.status).toBe(200);
  });
});

describe('/health touches the database', () => {
  it('a database failure is a 503 without details', async () => {
    const log = vi.fn();
    await setup();
    handler = createRequestHandler({
      app: createApp({ mailer: consoleMailer, now: Date.now }),
      env,
      ctx: work.ctx,
      site: await createStaticSite(fixtureDist()),
      checkDb: () => {
        throw new Error('SQLITE_CORRUPT: /secret/path');
      },
      maxBodyBytes: FILE_MAX_BYTES,
      log,
    });
    const r = await get('/health');
    expect(r.status).toBe(503);
    const text = await r.text();
    expect(JSON.parse(text)).toEqual({ error: { code: 'unavailable', message: 'Service unavailable.' } });
    expect(text).not.toContain('secret');
    expect(log).toHaveBeenCalledWith('error', 'health_db_failed', expect.anything());
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret');
  });
});

describe('HEAD and aborted bodies', () => {
  it('HEAD runs the GET route, keeps its headers and cancels its body', async () => {
    const cancelled = vi.fn();
    const app: AppLike = {
      fetch: (req: Request) => {
        expect(req.method).toBe('GET');
        return new Response(
          new ReadableStream({
            pull() {},
            cancel: cancelled,
          }),
          { status: 200, headers: { 'content-length': '5', 'x-a': '1' } },
        );
      },
    };
    await setup({}, app);
    const r = await get('/files/abc', {}, 'HEAD');
    expect(r.status).toBe(200);
    expect(r.body).toBeNull();
    expect(r.headers.get('content-length')).toBe('5');
    expect(r.headers.get('x-a')).toBe('1');
    expect(cancelled).toHaveBeenCalledOnce();
  });
});

describe('request body limit', () => {
  it('a declared Content-Length over the limit is refused before the app runs', async () => {
    const app = { fetch: vi.fn(() => new Response('x')) };
    await setup({}, app, 1_048_576);
    const r = await handler(
      new Request(`${ORIGIN}/w/clubhack/files`, { method: 'POST', headers: { 'Content-Length': '1048577', Origin: ORIGIN }, body: 'x' }),
    );
    expect(r.status).toBe(413);
    // The Workers wording for an over-limit upload, from the same helper.
    expect(await r.json()).toEqual({ error: { code: 'too_large', message: 'Files must be 1 MB or smaller.' } });
    expect(r.headers.get('connection')).toBe('close');
    expect(app.fetch).not.toHaveBeenCalled();
  });

  it('the server-layer 413 for the default limit reads exactly like the Workers route', async () => {
    await setup();
    const r = await handler(
      new Request(`${ORIGIN}/w/clubhack/files`, { method: 'POST', headers: { 'Content-Length': String(FILE_MAX_BYTES + 1), Origin: ORIGIN }, body: 'x' }),
    );
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual({ error: { code: 'too_large', message: 'Files must be 25 MB or smaller.' } });
  });

  it('a body without a length is cut off past the limit: the client gets the route\'s 400 invalid_request', async () => {
    await setup({}, undefined, 100);
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(`{"email":"${'a'.repeat(60)}`));
        c.enqueue(new TextEncoder().encode(`${'b'.repeat(60)}@test.local"}`));
        c.close();
      },
    });
    const r = await handler(
      new Request(`${ORIGIN}/auth/start`, { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body, duplex: 'half' } as RequestInit),
    );
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: { code: 'invalid_request', message: 'Invalid request body.' } });
  });

  it('a body without a length is cut off past the limit (the app sees a stream error)', async () => {
    let failure: unknown = null;
    const app: AppLike = {
      fetch: async (req: Request) => {
        try {
          await req.arrayBuffer();
        } catch (e) {
          failure = e;
        }
        return new Response('done');
      },
    };
    await setup({}, app, 100);
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(60));
        c.enqueue(new Uint8Array(60));
        c.close();
      },
    });
    await handler(new Request(`${ORIGIN}/messages/x`, { method: 'POST', body, duplex: 'half' } as RequestInit));
    expect(failure).toBeInstanceOf(Error);
  });
});

describe('FILE_MAX_BYTES and FILES_QUOTA_BYTES overrides (worker reads them from env)', () => {
  it('defaults are the protocol constants; env values override them', () => {
    expect(fileMaxBytes({})).toBe(FILE_MAX_BYTES);
    expect(filesQuotaBytes({})).toBe(FILES_QUOTA_BYTES);
    expect(fileMaxBytes({ FILE_MAX_BYTES: 1000 })).toBe(1000);
    expect(filesQuotaBytes({ FILES_QUOTA_BYTES: '5000' })).toBe(5000);
    expect(fileMaxBytes({ FILE_MAX_BYTES: 'junk' })).toBe(FILE_MAX_BYTES);
    expect(filesQuotaBytes({ FILES_QUOTA_BYTES: -1 })).toBe(FILES_QUOTA_BYTES);
  });

  const upload = (size: number) =>
    handler(
      new Request(`${ORIGIN}/w/clubhack/files?name=a.txt`, {
        method: 'POST',
        headers: { Origin: ORIGIN, Cookie: `backroom_session=${token}`, 'Content-Length': String(size), 'Content-Type': 'text/plain' },
        body: 'a'.repeat(size),
      }),
    );

  it('a lower FILE_MAX_BYTES refuses larger uploads with a matching message', async () => {
    await setup({ FILE_MAX_BYTES: 2 * 1_048_576 } as Partial<Env>);
    const r = await upload(2 * 1_048_576 + 1);
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual({ error: { code: 'too_large', message: 'Files must be 2 MB or smaller.' } });
    expect((await upload(10)).status).toBe(201);
  });

  it('a lower FILES_QUOTA_BYTES is the workspace quota', async () => {
    await setup({ FILES_QUOTA_BYTES: 1_048_576 } as Partial<Env>);
    expect((await upload(1_000_000)).status).toBe(201);
    const r = await upload(100_000);
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual({
      error: { code: 'quota_exceeded', message: 'This workspace has used its 1 MB of storage (files, thumbnails and custom emoji).' },
    });
  });
});

describe('waitUntil tracking', () => {
  it('drain() waits for registered work, including work added meanwhile; failures are logged by code only', async () => {
    const log = vi.fn();
    const t = createWorkTracker(log);
    const done: string[] = [];
    t.ctx.waitUntil(
      new Promise<void>((r) =>
        setTimeout(() => {
          done.push('a');
          t.ctx.waitUntil(new Promise<void>((r2) => setTimeout(() => (done.push('b'), r2()), 10)));
          r();
        }, 10),
      ),
    );
    t.ctx.waitUntil(Promise.reject(new Error('token=SECRET')));
    expect(t.size()).toBe(2);
    await t.drain();
    expect(done).toEqual(['a', 'b']);
    expect(t.size()).toBe(0);
    expect(log).toHaveBeenCalledWith('error', 'wait_until_failed', expect.anything());
    expect(JSON.stringify(log.mock.calls)).not.toContain('SECRET');
  });
});
