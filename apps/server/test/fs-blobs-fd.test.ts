import { existsSync, readdirSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { fileKey } from '../../worker/src/files/store';
import type { BlobStore } from '../../worker/src/lib/blobs';
import { createFsBlobStore } from '../src/platform/fs-blobs';
import { bytes, read, tempDir } from './helpers';

// Run with --expose-gc (vitest.config.ts execArgv). Regression for fix round 1: an open FileHandle that is garbage
// collected throws ERR_INVALID_STATE as an uncaught error on Node 26 and kills the process. Hono answers HEAD by
// running the GET handler and dropping the body, so get() must hold nothing open until the body is actually read.

const KEY = fileKey('01JCLUBHACK0000000000000WS', '01JBLOB0000000000000000000');
const BIG = 200 * 1024; // well above one 64 KiB read

const FD_DIR = existsSync('/proc/self/fd') ? '/proc/self/fd' : '/dev/fd';
const openFds = (): number => readdirSync(FD_DIR).length;
const tick = () => new Promise((r) => setImmediate(r));

async function collectGarbage(): Promise<void> {
  const gc = (globalThis as { gc?: () => void }).gc;
  expect(typeof gc, 'run with --expose-gc').toBe('function');
  for (let i = 0; i < 5; i++) {
    gc!();
    await tick();
  }
}

let store: BlobStore;
beforeEach(async () => {
  store = createFsBlobStore(tempDir());
  await store.put(KEY, bytes(BIG), { size: BIG });
});

describe('fs blob store: file handles', () => {
  it('200 dropped get() results hold no file open and survive garbage collection', async () => {
    const baseline = openFds();
    for (let i = 0; i < 200; i++) {
      const r = await store.get(KEY);
      expect(r!.body).not.toBeNull();
    }
    expect(openFds()).toBeLessThanOrEqual(baseline);
    await collectGarbage();
    // A collected open handle would have thrown ERR_INVALID_STATE (an uncaught error fails this run).
    expect(openFds()).toBeLessThanOrEqual(baseline);
  });

  it('HEAD-style: get() whose body is never touched opens nothing', async () => {
    const baseline = openFds();
    const r = await store.get(KEY, { range: { offset: 10, length: 100_000 } });
    expect(r!.size).toBe(BIG);
    expect(openFds()).toBe(baseline);
  });

  it('a stream cancelled half way closes its file', async () => {
    const baseline = openFds();
    const r = (await store.get(KEY))!;
    const reader = r.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(first.value!.byteLength).toBeLessThan(BIG);
    expect(openFds()).toBe(baseline + 1);
    await reader.cancel();
    await tick();
    expect(openFds()).toBe(baseline);
    await collectGarbage();
  });

  it('a stream read once and then abandoned (no cancel) is closed when collected, without crashing', async () => {
    const baseline = openFds();
    await (async () => {
      const r = (await store.get(KEY))!;
      const first = await r.body!.getReader().read();
      expect(first.done).toBe(false);
    })();
    expect(openFds()).toBe(baseline + 1);
    for (let i = 0; i < 10 && openFds() > baseline; i++) await collectGarbage();
    expect(openFds()).toBe(baseline);
  });

  it('a stream read to the end closes its file; so does a stream that errors', async () => {
    const baseline = openFds();
    expect(await read((await store.get(KEY))!.body)).toEqual(bytes(BIG));
    await tick();
    expect(openFds()).toBe(baseline);

    const gone = (await store.get(KEY))!;
    await store.delete(KEY); // removed before the first read: the lazy open finds nothing
    await expect(read(gone.body)).rejects.toThrow();
    await tick();
    expect(openFds()).toBe(baseline);
  });

  it('a reader that started keeps its bytes across an overwrite and a delete (positioned reads after unlink)', async () => {
    const r = (await store.get(KEY))!;
    const reader = r.body!.getReader();
    const parts: Uint8Array[] = [];
    const first = await reader.read();
    parts.push(first.value!);
    expect(first.value!.byteLength).toBeLessThan(BIG); // more reads follow after the unlink
    await store.put(KEY, bytes(10), { size: 10 });
    await store.delete(KEY);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }
    expect(await read(new Blob(parts).stream())).toEqual(bytes(BIG));
  });

  it('peek and a not-modified get() leave nothing open', async () => {
    const baseline = openFds();
    const full = (await store.get(KEY))!;
    await full.body!.cancel();
    for (let i = 0; i < 20; i++) {
      await store.peek(KEY, 16);
      await store.get(KEY, { ifNoneMatch: full.etag });
    }
    await tick();
    expect(openFds()).toBe(baseline);
  });
});
