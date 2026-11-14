import { type Dirent, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';

/** The worker's migrations: the server applies exactly these files (no SQL changes in Phase 7). */
export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../worker/migrations');

const dirs: string[] = [];

/** A fresh temporary directory, removed after the test. */
export function tempDir(prefix = 'backroom-server-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

export const bytes = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => i % 251);

export async function read(s: ReadableStream | null): Promise<Uint8Array> {
  return new Uint8Array(await new Response(s).arrayBuffer());
}

export function chunked(parts: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(p);
      c.close();
    },
  });
}

/** A stream that delivers `first`, then fails (a client that disconnects mid-upload). */
export function failingAfter(first: Uint8Array): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream({
    pull(c) {
      if (!sent) {
        sent = true;
        c.enqueue(first);
        return;
      }
      c.error(new Error('client went away'));
    },
  });
}

/** Every regular file under `dir`, as paths relative to it. */
export function storedFiles(dir: string): string[] {
  return (readdirSync(dir, { recursive: true, withFileTypes: true }) as Dirent[])
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)))
    .sort();
}

/** Binds a free localhost port at 8790 or above (never 8787/8788, which belong to the user's dev servers). */
export async function listenLocal(s: Server): Promise<number> {
  for (let p = 8790; p < 8890; p++) {
    const ok = await new Promise<boolean>((resolve) => {
      const onError = () => resolve(false);
      s.once('error', onError);
      s.listen(p, '127.0.0.1', () => {
        s.off('error', onError);
        resolve(true);
      });
    });
    if (ok) return p;
  }
  throw new Error('no free port in 8790-8889');
}

/** The web app's real _headers file. */
export const WEB_HEADERS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../web/public/_headers'), 'utf8');

/** A tiny stand-in for apps/web/dist (the real build is never written by tests). */
export function fixtureDist(root: string = tempDir('backroom-web-')): string {
  mkdirSync(root, { recursive: true });
  const put = (p: string, body: string | Uint8Array) => {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), body);
  };
  put('index.html', '<!doctype html><title>Backroom</title><div id="root"></div>');
  put('assets/index-AbC123xy.js', 'console.log("app")');
  put('assets/index-AbC123xy.css', 'body{}');
  put('assets/font-Zz9.woff2', new Uint8Array([1, 2, 3]));
  put('twemoji/1f600.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
  put('favicon.ico', new Uint8Array([0, 0, 1, 0]));
  put('robots.txt', 'User-agent: *');
  put('_headers', WEB_HEADERS);
  put('.hidden', 'secret');
  return root;
}

