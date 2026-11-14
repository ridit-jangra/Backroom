import { type Dirent, mkdtempSync, readdirSync, rmSync } from 'node:fs';
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
