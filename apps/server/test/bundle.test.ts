/**
 * Integration: builds dist/server.mjs into a scratch directory, starts it as a real process (console mailer, temp
 * DATA_DIR, a tiny web fixture, a free port at 8790+) and drives HTTP and WebSocket traffic through it.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { get as httpGet, request as httpRequest } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { connect as netConnect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseHubFrame, type HubFrame } from '@backroom/protocol';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { fixtureDist } from './helpers';

const here = dirname(fileURLToPath(import.meta.url));
const BUILD = join(here, '../build.mjs');
const GENERAL = '01JCLUBHACK0000000000000GN';
const OWNER = 'owner@test.local';
const BODY = 'hello from the node server';
// A 1x1 transparent PNG (67 bytes).
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082',
  'hex',
);

let scratch: string;
let outDir: string;
let dataDir: string;
let port: number;
let origin: string;
let proc: ChildProcess;
const lines: string[] = [];
let exitCode: Promise<number | null>;
let web: string;

/**
 * Every server process this file starts. afterAll kills whatever is still running (a failed assertion must not leave
 * a server behind), and a process 'exit' hook does the same if vitest exits without running afterAll.
 */
const children = new Set<ChildProcess>();
function track<T extends ChildProcess>(p: T): T {
  children.add(p);
  p.once('exit', () => children.delete(p));
  return p;
}
function killAll(): void {
  for (const p of children) {
    try {
      p.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}
process.once('exit', killAll);

/** Pids of live processes whose command line mentions `needle` (Linux /proc; empty elsewhere). */
function processesMentioning(needle: string): number[] {
  if (!existsSync('/proc')) return [];
  const out: number[] = [];
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d) || Number(d) === process.pid) continue;
    try {
      if (readFileSync(`/proc/${d}/cmdline`, 'utf8').includes(needle)) out.push(Number(d));
    } catch {
      /* exited meanwhile */
    }
  }
  return out;
}

/** The environment of the server under test (overrides for the extra processes some tests start). */
function serverEnv(over: Record<string, string> = {}): Record<string, string | undefined> {
  return {
    PATH: process.env.PATH,
    TZ: 'UTC',
    APP_ORIGIN: origin,
    OWNER_EMAIL: OWNER,
    RESEND_API_KEY: 'dev',
    DATA_DIR: dataDir,
    PORT: String(port),
    HOST: '127.0.0.1',
    WEB_DIST: web,
    ...over,
  };
}

/** Runs the built server with extra arguments/env to completion (or kills it after `timeoutMs`). */
function runServer(args: string[], env: Record<string, string | undefined>, timeoutMs = 15_000, until?: RegExp) {
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    const p = track(spawn(process.execPath, [join(outDir, 'server.mjs'), ...args], { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'] }));
    let out = '';
    const onData = (d: Buffer) => {
      out += d.toString();
      if (until && until.test(out)) p.kill('SIGTERM');
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}
let cookie = '';
let fileId = '';
const sockets: Client[] = [];

/**
 * A port that is free right now, at 8900 or above: still clear of 8787/8788, and above the 8790-8889 range the
 * in-process server tests (listenLocal) use concurrently. The server may still lose a race for it; see start().
 */
async function freePort(from: number): Promise<number> {
  for (let p = from; p < 9000; p++) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = createServer();
      s.once('error', () => resolve(false));
      s.listen(p, '127.0.0.1', () => s.close(() => resolve(true)));
    });
    if (ok) return p;
  }
  throw new Error('no free port in 8900-8999');
}

async function waitForLine(re: RegExp, timeoutMs = 10_000): Promise<RegExpMatchArray> {
  const start = Date.now();
  for (;;) {
    for (const l of lines) {
      const m = re.exec(l);
      if (m) return m;
    }
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${re}; output:\n${lines.join('\n')}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const jsonLines = () => lines.flatMap((l) => (l.startsWith('{') ? [JSON.parse(l) as Record<string, unknown>] : []));

function req(path: string, init: RequestInit & { headers?: Record<string, string> } = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...init.headers } });
}

/** A plain GET through node:http (fetch always sends Sec-Fetch-Mode: cors, so it can't act as a navigation). */
function rawGet(path: string, headers: Record<string, string>): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    httpGet({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    }).on('error', reject);
  });
}

/** Sends raw bytes on a fresh connection; resolves with everything the server wrote before closing (or 2 s). */
function raw(bytes: string, waitMs = 2_000): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    const s = netConnect(port, '127.0.0.1', () => s.write(bytes));
    const timer = setTimeout(() => s.destroy(), waitMs);
    s.on('data', (d) => (out += d.toString('latin1')));
    s.on('error', () => {});
    s.on('close', () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

class Client {
  queue: HubFrame[] = [];
  closed: Promise<number>;
  constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => {
      const f = parseHubFrame(d.toString());
      if (f) this.queue.push(f);
    });
    this.closed = new Promise((r) => ws.on('close', (code) => r(code)));
  }
  async next<K extends HubFrame['t']>(t: K, timeoutMs = 5_000): Promise<Extract<HubFrame, { t: K }>> {
    const start = Date.now();
    for (;;) {
      const i = this.queue.findIndex((f) => f.t === t);
      if (i >= 0) return this.queue.splice(i, 1)[0] as never;
      if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${t}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

async function connect(): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?workspace=clubhack`, { headers: { Cookie: cookie, Origin: origin } });
  const c = new Client(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  sockets.push(c);
  return c;
}

function rateLimitRows(dir = dataDir): { key: string; count: number }[] {
  const db = new DatabaseSync(join(dir, 'backroom.sqlite'));
  try {
    return db.prepare("SELECT key, count FROM rate_limits WHERE key LIKE 'start:ip:%' ORDER BY key").all() as never;
  } finally {
    db.close();
  }
}

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'backroom-bundle-'));
  outDir = join(scratch, 'dist');
  execFileSync(process.execPath, [BUILD, '--outdir', outDir], { stdio: 'pipe', timeout: 120_000 });
  web = fixtureDist(join(scratch, 'web'));
  const gcHook = join(scratch, 'gc-hook.mjs');
  writeFileSync(
    gcHook,
    "process.on('SIGUSR2', () => { globalThis.gc(); globalThis.gc(); process.stdout.write(JSON.stringify({ code: 'test_gc_done' }) + '\\n'); });\n",
  );
  let from = 8900;
  for (let attempt = 0; ; attempt++) {
    port = await freePort(from);
    origin = `http://localhost:${port}`;
    dataDir = join(scratch, `state-${attempt}`, 'data');
    lines.length = 0;
    proc = track(
      spawn(process.execPath, ['--expose-gc', '--import', pathToFileURL(gcHook).href, join(outDir, 'server.mjs')], {
        cwd: scratch,
        env: serverEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
    const p = proc;
    exitCode = new Promise((r) => p.on('exit', (code) => r(code)));
    let buf = '';
    const onData = (d: Buffer) => {
      buf += d.toString();
      const parts = buf.split('\n');
      buf = parts.pop()!;
      lines.push(...parts.filter(Boolean));
    };
    p.stdout!.on('data', onData);
    p.stderr!.on('data', onData);
    const started = await Promise.race([waitForLine(/"code":"server_started"/, 20_000).then(() => true), exitCode.then(() => false)]);
    if (started) break;
    // Lost the port to another process between the probe and the listen: try the next one.
    if (attempt >= 4 || !lines.some((l) => l.includes('cannot listen'))) throw new Error(`server did not start:\n${lines.join('\n')}`);
    from = port + 1;
  }
}, 180_000);

afterAll(async () => {
  for (const s of sockets) s.ws.terminate();
  const live = [...children];
  killAll();
  await Promise.all(live.map((p) => (p.exitCode !== null || p.signalCode !== null ? null : new Promise((r) => p.once('exit', r)))));
  // Nothing started from this scratch directory may outlive the suite.
  const leftovers = scratch ? processesMentioning(scratch) : [];
  for (const pid of leftovers) process.kill(pid, 'SIGKILL');
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  expect(leftovers, 'server processes left running by the bundle tests').toEqual([]);
}, 30_000);

describe('the built server (dist/server.mjs)', () => {
  it('bundles migrations next to the server and prints a startup summary without secrets', () => {
    expect(readdirSync(join(outDir, 'migrations')).filter((n) => n.endsWith('.sql'))).toHaveLength(8);
    const started = jsonLines().find((l) => l.code === 'server_started')!;
    expect(started).toMatchObject({
      level: 'info',
      port,
      host: '127.0.0.1',
      dataDir,
      firstRun: true,
      migrationsApplied: 8,
      mailer: 'console',
      trustedProxyHeader: null,
      trustedProxySecret: false,
      keepAliveTimeoutMs: 190_000,
      maxConnections: 2048,
    });
    expect(JSON.stringify(started)).not.toContain(OWNER);
    expect(statSync(dataDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dataDir, 'blobs')).mode & 0o777).toBe(0o700);
  });

  it('health, static files, the SPA shell and JSON 404s', async () => {
    const h = await req('/health');
    expect(h.status).toBe(200);
    expect(await h.json()).toEqual({ ok: true });
    const shell = await rawGet('/client/clubhack', { 'Sec-Fetch-Mode': 'navigate', Accept: 'text/html' });
    expect(shell.status).toBe(200);
    expect(shell.headers['cache-control']).toBe('public, max-age=0, must-revalidate');
    expect(shell.body).toContain('<div id="root">');
    const js = await req('/assets/index-AbC123xy.js');
    expect(js.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(js.headers.get('x-content-type-options')).toBe('nosniff');
    await js.arrayBuffer();
    const miss = await rawGet('/w/clubhack/nope', { 'Sec-Fetch-Mode': 'navigate', Accept: 'text/html' });
    expect(miss.status).toBe(404);
    expect(JSON.parse(miss.body)).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
    const asset = await req('/nope.js');
    expect(asset.status).toBe(404);
    expect(asset.headers.get('content-type')).toMatch(/application\/json/);
    await asset.arrayBuffer();
    const trav = await req('/..%2f..%2fetc/passwd');
    expect(await trav.text()).not.toContain('root:');
  });

  it('sign in through the console mailer link, then bootstrap with the cookie', async () => {
    const start = await req('/auth/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: OWNER }) });
    expect(start.status).toBe(200);
    const m = await waitForLine(/Sign-in link for \S+: (\S+)/);
    const token = new URL(m[1]!).searchParams.get('t')!;
    expect(new URL(m[1]!).origin).toBe(origin);
    const verify = await req('/auth/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    expect(verify.status).toBe(200);
    cookie = verify.headers.getSetCookie()[0]!.split(';')[0]!;
    expect(cookie).toMatch(/^backroom_session=/);
    const boot = await req('/w/clubhack/bootstrap');
    expect(boot.status).toBe(200);
    expect(JSON.stringify(await boot.json())).toContain(GENERAL);
  });

  it('WebSocket: hello, send, ack, and a second client receives the message', async () => {
    const a = await connect();
    const b = await connect();
    a.ws.send(JSON.stringify({ t: 'hello', lastSeen: {} }));
    b.ws.send(JSON.stringify({ t: 'hello', lastSeen: {} }));
    await a.next('catchup');
    await b.next('catchup');
    a.ws.send(JSON.stringify({ t: 'send', clientId: 'bundle-1-xxxxxx', channelId: GENERAL, body: BODY }));
    const ack = await a.next('ack');
    expect(ack.message.body).toBe(BODY);
    const got = await b.next('message.new');
    expect(got.message.id).toBe(ack.message.id);
  });

  it('file upload and a ranged download (206)', async () => {
    const up = await req('/w/clubhack/files?name=dot.png', {
      method: 'POST',
      headers: { 'Content-Type': 'image/png', 'Content-Length': String(PNG.byteLength) },
      body: PNG,
    });
    expect(up.status).toBe(201);
    const { file } = (await up.json()) as { file: { id: string; mime: string; size: number } };
    expect(file).toMatchObject({ mime: 'image/png', size: PNG.byteLength });
    fileId = file.id;
    const part = await req(`/files/${fileId}`, { headers: { Range: 'bytes=0-9' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 0-9/${PNG.byteLength}`);
    expect(Buffer.from(await part.arrayBuffer())).toEqual(PNG.subarray(0, 10));
    const whole = await req(`/files/${fileId}`);
    expect(Buffer.from(await whole.arrayBuffer())).toEqual(PNG);
  });

  it('HEAD on a file (plain and ranged) and an aborted download leave nothing for GC to trip over', async () => {
    const fds = () => (existsSync(`/proc/${proc.pid}/fd`) ? readdirSync(`/proc/${proc.pid}/fd`).length : 0);
    const baseline = fds();
    for (let i = 0; i < 20; i++) {
      const h = await req(`/files/${fileId}`, { method: 'HEAD', ...(i % 2 ? { headers: { Range: 'bytes=0-3' } } : {}) });
      expect(h.status).toBe(i % 2 ? 206 : 200);
      expect(h.headers.get('content-length')).toBe(i % 2 ? '4' : String(PNG.byteLength));
    }
    // A file larger than one read chunk, so a body that was started and then dropped would keep its file open.
    const big = Buffer.alloc(1_048_576, 7);
    const upBig = await req('/w/clubhack/files?name=big.bin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(big.byteLength) },
      body: big,
    });
    expect(upBig.status).toBe(201);
    const bigId = ((await upBig.json()) as { file: { id: string } }).file.id;
    for (let i = 0; i < 10; i++) {
      const h = await req(`/files/${bigId}`, { method: 'HEAD', headers: { Range: `bytes=${i}-1000000` } });
      expect(h.status).toBe(206);
      expect((await req(`/files/${bigId}`, { method: 'HEAD' })).status).toBe(200);
    }
    const ac = new AbortController();
    const aborted = await req(`/files/${bigId}`, { signal: ac.signal });
    ac.abort();
    await aborted.arrayBuffer().catch(() => {});
    // Every blob read was cancelled (not left to the garbage collector): the server holds no extra files.
    await vi.waitFor(() => expect(fds()).toBeLessThanOrEqual(baseline), { timeout: 3_000 });
    proc.kill('SIGUSR2');
    await waitForLine(/"code":"test_gc_done"/);
    await new Promise((r) => setTimeout(r, 200));
    expect(proc.exitCode).toBeNull();
    expect((await req('/health')).status).toBe(200);
  });

  it('search finds the sent message', async () => {
    const r = await req('/w/clubhack/search?q=node');
    expect(r.status).toBe(200);
    const page = (await r.json()) as { results: { message: { body: string } }[] };
    expect(JSON.stringify(page)).toContain('node server');
  });

  it('spoofed CF-Connecting-IP / X-Forwarded-For headers do not change the rate-limit bucket', async () => {
    const before = rateLimitRows();
    expect(before.map((r) => r.key)).toEqual(['start:ip:127.0.0.1']);
    const r = await req('/auth/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '6.6.6.6', 'X-Forwarded-For': '7.7.7.7' },
      body: JSON.stringify({ email: 'someone@test.local' }),
    });
    expect(r.status).toBe(200);
    const after = rateLimitRows();
    expect(after.map((x) => x.key)).toEqual(['start:ip:127.0.0.1']);
    expect(after[0]!.count).toBe(before[0]!.count + 1);
  });

  it('--maintenance while an upload is streaming: the upload still succeeds (no sweep, no migrations)', { timeout: 30_000 }, async () => {
    const N = 300_000;
    const data = Buffer.alloc(N, 3);
    const r = httpRequest({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/w/clubhack/files?name=slow.bin',
      headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/octet-stream', 'Content-Length': N },
    });
    const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
      r.on('response', (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode!, body }));
      });
      r.on('error', reject);
    });
    r.write(data.subarray(0, N / 2));
    // Give the server time to start the blob's temp file.
    await vi.waitFor(() => expect(readdirSync(join(dataDir, 'blobs', '.tmp')).length).toBeGreaterThan(0), { timeout: 3_000 });
    const m = await runServer(['--maintenance'], serverEnv());
    expect(m.code, m.out).toBe(0);
    expect(m.out).toContain('"code":"maintenance_done"');
    r.end(data.subarray(N / 2));
    const res = await response;
    expect(res.status, res.body).toBe(201);
    const id = (JSON.parse(res.body) as { file: { id: string } }).file.id;
    expect(Buffer.from(await (await req(`/files/${id}`)).arrayBuffer()).equals(data)).toBe(true);
  });

  it('--maintenance refuses a data dir without a database (never creates or migrates one)', { timeout: 30_000 }, async () => {
    const empty = join(scratch, 'empty-data');
    const m = await runServer(['--maintenance'], serverEnv({ DATA_DIR: empty }));
    expect(m.code).toBe(1);
    expect(m.out).toMatch(/no database/i);
    expect(existsSync(join(empty, 'backroom.sqlite'))).toBe(false);
  });

  it('--backup while the server runs: a verified snapshot and the blobs, no lock taken, nothing secret printed', { timeout: 30_000 }, async () => {
    const dest = join(scratch, 'backups');
    // Only DATA_DIR: a backup needs neither APP_ORIGIN nor OWNER_EMAIL. RESEND_API_KEY must never be printed.
    const b = await runServer(['--backup', dest, '--keep', '2'], { PATH: process.env.PATH, TZ: 'UTC', DATA_DIR: dataDir, RESEND_API_KEY: 're_never_print_me' });
    expect(b.code, b.out).toBe(0);
    expect(b.out).toContain('"code":"backup_done"');
    const snaps = readdirSync(dest).filter((n) => /^backroom-\d{8}T\d{6}Z\.sqlite$/.test(n));
    expect(snaps).toHaveLength(1);
    const db = new DatabaseSync(join(dest, snaps[0]!), { readOnly: true });
    try {
      expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
      expect((db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n).toBeGreaterThanOrEqual(1);
    } finally {
      db.close();
    }
    expect(readdirSync(join(dest, 'blobs')).length).toBeGreaterThan(0);
    expect(existsSync(join(dest, 'blobs', '.tmp'))).toBe(false);
    expect(existsSync(join(dataDir, 'server.lock'))).toBe(true);
    expect((await req('/health')).status).toBe(200);
    for (const s of [BODY, OWNER, 're_never_print_me', cookie.split('=')[1]!, 'ws~']) expect(b.out).not.toContain(s);
  });

  it('a second server on the same DATA_DIR refuses to start, and the first keeps serving', { timeout: 30_000 }, async () => {
    const second = await runServer([], serverEnv({ PORT: String(await freePort(port + 1)) }));
    expect(second.code).toBe(1);
    expect(second.out).toMatch(/another Backroom server .*is using this DATA_DIR/);
    expect(existsSync(join(dataDir, 'server.lock'))).toBe(true);
    expect((await req('/health')).status).toBe(200);
  });

  it('a server.lock left by a crashed server is taken over', { timeout: 30_000 }, async () => {
    const dir = join(scratch, 'crashed', 'data');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'server.lock'), JSON.stringify({ pid: 2 ** 22 + 4321, start: null, at: Date.now() - 60_000, token: 'old' }));
    const other = await freePort(port + 1);
    const run = await runServer([], serverEnv({ DATA_DIR: dir, PORT: String(other), APP_ORIGIN: `http://localhost:${other}` }), 20_000, /"code":"server_started"/);
    expect(run.out).toContain('"code":"server_started"');
    expect(run.code).toBe(0);
    expect(existsSync(join(dir, 'server.lock'))).toBe(false);
  });

  it('TRUSTED_PROXY_SECRET: CF-Connecting-IP is believed only with the right origin secret', { timeout: 30_000 }, async () => {
    const SECRET = 'bundle-origin-secret-0123456789abcdef';
    const dir = join(scratch, 'secret', 'data');
    const p2 = await freePort(port + 1);
    const o2 = `http://localhost:${p2}`;
    const child = track(
      spawn(process.execPath, [join(outDir, 'server.mjs')], {
        cwd: scratch,
        env: serverEnv({ DATA_DIR: dir, PORT: String(p2), APP_ORIGIN: o2, TRUSTED_PROXY_HEADER: 'cf-connecting-ip', TRUSTED_PROXY_SECRET: SECRET }),
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
    await vi.waitFor(() => expect(out).toContain('"code":"server_started"'), { timeout: 15_000 });
    const start = (headers: Record<string, string>) =>
      fetch(`http://127.0.0.1:${p2}/auth/start`, {
        method: 'POST',
        headers: { Origin: o2, 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ email: 'nobody@test.local' }),
      });
    expect((await start({ 'CF-Connecting-IP': '203.0.113.5', 'X-Backroom-Origin-Secret': SECRET })).status).toBe(200);
    expect((await start({ 'CF-Connecting-IP': '6.6.6.6', 'X-Backroom-Origin-Secret': 'wrong-secret-0123456789abcdef-xx' })).status).toBe(200);
    expect((await start({ 'CF-Connecting-IP': '7.7.7.7' })).status).toBe(200);
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
    expect(rateLimitRows(dir)).toEqual([
      { key: 'start:ip:127.0.0.1', count: 2 },
      { key: 'start:ip:203.0.113.5', count: 1 },
    ]);
    expect(out).toContain('"trustedProxySecret":true');
    expect(out).not.toContain(SECRET);
  });

  it('an upload declaring more than FILE_MAX_BYTES gets the Workers 413 at once and the connection is closed', async () => {
    const t0 = Date.now();
    const reply = await raw(
      `POST /w/clubhack/files?name=x.bin HTTP/1.1\r\nHost: x\r\nOrigin: ${origin}\r\nCookie: ${cookie}\r\nContent-Type: application/octet-stream\r\nContent-Length: 104857600\r\n\r\n0123456789`,
      5_000,
    );
    expect(reply).toMatch(/^HTTP\/1\.1 413 /);
    expect(reply).toContain('{"error":{"code":"too_large","message":"Files must be 25 MB or smaller."}}');
    // Closed by the server, not by the 5 s test timeout, and without waiting for 100 MB.
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  it.each([
    ['TRACE upgrade on /ws', 'TRACE /ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'],
    ['TRACK upgrade on /ws', 'TRACK /ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'],
    ['POST upgrade on /ws', 'POST /ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nContent-Length: 0\r\n\r\n'],
    ['GET * upgrade', 'GET * HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'],
    ['upgrade with a malformed Host', 'GET /ws HTTP/1.1\r\nHost: [bad\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'],
    ['absolute-form upgrade', 'GET http://evil.example/ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'],
    ['GET *', 'GET * HTTP/1.1\r\nHost: x\r\n\r\n'],
    ['OPTIONS *', 'OPTIONS * HTTP/1.1\r\nHost: x\r\n\r\n'],
    ['malformed Host', 'GET /health HTTP/1.1\r\nHost: [bad\r\nConnection: close\r\n\r\n'],
    ['Host with a path', 'GET /health HTTP/1.1\r\nHost: a/b?c\r\nConnection: close\r\n\r\n'],
    ['absolute-form request', 'GET http://evil.example/health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'],
    ['repeated CF-Connecting-IP lines', 'GET /health HTTP/1.1\r\nHost: x\r\nCF-Connecting-IP: 6.6.6.6\r\nCF-Connecting-IP: 5.5.5.5\r\nCF-Connecting-IP: 4.4.4.4\r\nConnection: close\r\n\r\n'],
    ['repeated Host lines', 'GET /health HTTP/1.1\r\nHost: a\r\nHost: b\r\nHost: c\r\nConnection: close\r\n\r\n'],
    ['repeated origin-secret and CF-Connecting-IP lines on an upgrade', 'GET /ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nX-Backroom-Origin-Secret: a\r\nX-Backroom-Origin-Secret: b\r\nCF-Connecting-IP: 6.6.6.6\r\nCF-Connecting-IP: 5.5.5.5\r\n\r\n'],
    ['TRACE', 'TRACE / HTTP/1.1\r\nHost: x\r\n\r\n'],
    ['TRACK', 'TRACK / HTTP/1.1\r\nHost: x\r\n\r\n'],
    ['CONNECT', 'CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n'],
  ])('hostile request (%s) never stops the server', async (_name, bytes) => {
    const reply = await raw(bytes);
    const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(reply)?.[1] ?? 0);
    // A refusal, a plain close, or (for a fixable Host / absolute-form target) a normal answer: never a 5xx or a crash.
    expect(status < 500, reply.split('\r\n')[0]).toBe(true);
    const h = await req('/health');
    expect(h.status).toBe(200);
    expect(proc.exitCode).toBeNull();
  });

  it('GET * is a 400, not a 500', async () => {
    expect(await raw('GET * HTTP/1.1\r\nHost: x\r\n\r\n')).toMatch(/^HTTP\/1\.1 400 /);
    expect(jsonLines().some((l) => l.code === 'uncaught_exception' || l.code === 'request_failed')).toBe(false);
  });

  it('SIGTERM: sockets close with 1001, the process exits 0, and the database is intact', async () => {
    const closes = sockets.map((s) => s.closed);
    proc.kill('SIGTERM');
    expect(await exitCode).toBe(0);
    expect(await Promise.all(closes)).toEqual(sockets.map(() => 1001));
    expect(jsonLines().some((l) => l.code === 'shutdown_complete')).toBe(true);
    const db = new DatabaseSync(join(dataDir, 'backroom.sqlite'));
    try {
      expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
      expect((db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n).toBe(1);
    } finally {
      db.close();
    }
  });

  it('logs never carry message bodies, tokens or the session cookie; emails appear only in the console mailer line', () => {
    const token = cookie.split('=')[1]!;
    for (const l of lines) {
      expect(l).not.toContain(BODY);
      expect(l).not.toContain(token);
      if (!l.startsWith('Sign-in link for ')) {
        expect(l).not.toContain(OWNER);
        expect(l).not.toContain('someone@test.local');
      }
    }
  });
});
