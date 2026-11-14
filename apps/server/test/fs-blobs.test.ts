import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { emojiKey } from '../../worker/src/emoji/custom';
import { FILE_KEY_RE, fileKey, thumbKeyOf } from '../../worker/src/files/store';
import { type BlobStore, getBlobStore } from '../../worker/src/lib/blobs';
import { parseRange } from '../../worker/src/files/http';
import { EMOJI_KEY_RE, createFsBlobStore } from '../src/platform/fs-blobs';
import { bytes, chunked, failingAfter, read, storedFiles, tempDir } from './helpers';

const WS = '01JCLUBHACK0000000000000WS';
const KEY = fileKey(WS, '01JBLOB0000000000000000000');
const key = (n: number) => fileKey(WS, `01JBLOB${String(n).padStart(19, '0')}`);

let dir: string;
let store: BlobStore;
beforeEach(() => {
  dir = tempDir();
  store = createFsBlobStore(dir);
});

/** The same cases as apps/worker/test/blobs.test.ts `describeBackends('BlobStore')`, on the filesystem backend. */
describe('BlobStore [fs] (the worker suite\'s cases)', () => {
  it('round-trips bytes with size, content type and a quoted etag', async () => {
    await store.put(KEY, bytes(1000), { contentType: 'image/png', size: 1000 });
    const got = await store.get(KEY);
    expect(got).not.toBeNull();
    expect(got!.notModified).toBe(false);
    expect(got!.size).toBe(1000);
    expect(got!.contentType).toBe('image/png');
    expect(got!.etag).toMatch(/^"[^"]+"$/);
    expect(got!.range).toBeUndefined();
    expect(await read(got!.body)).toEqual(bytes(1000));
  });

  it('accepts a stream body of known length (and an ArrayBuffer); missing keys are null', async () => {
    await store.put(KEY, chunked([bytes(100), bytes(200)]), { size: 300 });
    const got = await store.get(KEY);
    expect(got!.size).toBe(300);
    expect(got!.contentType).toBeNull();
    expect((await read(got!.body)).length).toBe(300);
    await store.put(key(2), bytes(7).buffer as ArrayBuffer, { size: 7 });
    expect(await store.peek(key(2), 100)).toEqual(bytes(7));
    expect(await store.get(key(3))).toBeNull();
    expect(await store.peek(key(3), 10)).toBeNull();
  });

  it('a new put gets a new etag (a random id per write, like KV)', async () => {
    await store.put(KEY, bytes(10), { size: 10 });
    const a = (await store.get(KEY))!;
    await read(a.body);
    await store.put(KEY, bytes(10), { size: 10 });
    const b = (await store.get(KEY))!;
    await read(b.body);
    expect(a.etag).not.toBe(b.etag);
  });

  it('range: offset/length and the suffix shape (last n bytes) return exactly those bytes', async () => {
    const data = bytes(5000);
    await store.put(KEY, data, { size: 5000 });
    const mid = (await store.get(KEY, { range: { offset: 1234, length: 100 } }))!;
    expect(mid.size).toBe(5000);
    expect(mid.range).toEqual({ offset: 1234, length: 100 });
    expect(await read(mid.body)).toEqual(data.subarray(1234, 1334));
    const suffix = parseRange('bytes=-500', 5000);
    expect(suffix).toEqual({ offset: 4500, length: 500 });
    const tail = (await store.get(KEY, { range: suffix as { offset: number; length: number } }))!;
    expect(await read(tail.body)).toEqual(data.subarray(4500));
    const first = (await store.get(KEY, { range: { offset: 0, length: 1 } }))!;
    expect(await read(first.body)).toEqual(data.subarray(0, 1));
    const open = parseRange('bytes=4990-', 5000) as { offset: number; length: number };
    expect(await read((await store.get(KEY, { range: open }))!.body)).toEqual(data.subarray(4990));
  });

  it('a range outside the blob is rejected (the route answers 416 before asking: parseRange)', async () => {
    await store.put(KEY, bytes(10), { size: 10 });
    expect(parseRange('bytes=10-', 10)).toBe('unsatisfiable');
    await expect(store.get(KEY, { range: { offset: 5, length: 6 } })).rejects.toThrow(RangeError);
    await expect(store.get(KEY, { range: { offset: -1, length: 1 } })).rejects.toThrow(RangeError);
  });

  it('If-None-Match: the stored etag (strong, weak, in a list, or *) is notModified without a body', async () => {
    await store.put(KEY, bytes(64), { contentType: 'image/webp', size: 64 });
    const full = (await store.get(KEY))!;
    await read(full.body);
    for (const h of [full.etag, `W/${full.etag}`, `"zzz", ${full.etag}`, '*']) {
      const r = (await store.get(KEY, { ifNoneMatch: h }))!;
      expect(r.notModified, h).toBe(true);
      expect(r.body).toBeNull();
      expect(r.etag).toBe(full.etag);
      expect(r.size).toBe(64);
      expect(r.contentType).toBe('image/webp');
    }
    const ranged = (await store.get(KEY, { ifNoneMatch: full.etag, range: { offset: 0, length: 8 } }))!;
    expect(ranged.notModified).toBe(true);
  });

  it('If-None-Match: another etag, or a malformed validator, serves the body', async () => {
    await store.put(KEY, bytes(64), { size: 64 });
    for (const h of ['"nope"', 'abc', 'W/', '""']) {
      const r = (await store.get(KEY, { ifNoneMatch: h }))!;
      expect(r.notModified, h).toBe(false);
      expect(await read(r.body)).toEqual(bytes(64));
    }
  });

  it('peek returns at most the first n bytes', async () => {
    await store.put(KEY, bytes(500), { size: 500 });
    expect(await store.peek(KEY, 16)).toEqual(bytes(16));
    expect(await store.peek(KEY, 10_000)).toEqual(bytes(500));
  });

  it('delete takes one key or several; missing keys are fine', async () => {
    const keys = [key(1), key(2), key(3)];
    for (const k of keys) await store.put(k, bytes(1), { size: 1 });
    await store.delete(keys[0]!);
    expect(await store.get(keys[0]!)).toBeNull();
    await store.delete([keys[1]!, keys[2]!, key(4)]);
    for (const k of keys) expect(await store.get(k)).toBeNull();
    expect(storedFiles(dir).filter((f) => !f.startsWith('.tmp'))).toEqual([]);
  });

  it('a zero-byte blob round-trips', async () => {
    await store.put(KEY, new Uint8Array(0), { size: 0 });
    const got = (await store.get(KEY))!;
    expect(got.size).toBe(0);
    expect(await read(got.body)).toEqual(new Uint8Array(0));
    expect(await store.peek(KEY, 10)).toEqual(new Uint8Array(0));
  });
});

describe('fs blob store: atomic writes', () => {
  it('reports failedPutLeavesNothing (a failed put writes nothing)', () => {
    expect(store.failedPutLeavesNothing).toBe(true);
  });

  it('a short stream body is an error and leaves nothing behind', async () => {
    await expect(store.put(KEY, chunked([bytes(10)]), { size: 11 })).rejects.toThrow(/length/);
    expect(await store.get(KEY)).toBeNull();
    expect(storedFiles(dir)).toEqual([]);
  });

  it('a long stream body (or bytes of the wrong size) is an error and leaves nothing behind', async () => {
    await expect(store.put(KEY, chunked([bytes(10), bytes(10)]), { size: 15 })).rejects.toThrow(/length/);
    await expect(store.put(KEY, bytes(3), { size: 4 })).rejects.toThrow(/length/);
    expect(storedFiles(dir)).toEqual([]);
  });

  it('a stream that errors mid-upload rejects and leaves nothing behind', async () => {
    await expect(store.put(KEY, failingAfter(bytes(100)), { size: 1000 })).rejects.toThrow('client went away');
    expect(await store.get(KEY)).toBeNull();
    expect(storedFiles(dir)).toEqual([]);
  });

  it('a failed overwrite keeps the previous blob intact', async () => {
    await store.put(KEY, bytes(20), { contentType: 'text/plain', size: 20 });
    const before = (await store.get(KEY))!;
    await read(before.body);
    await expect(store.put(KEY, failingAfter(bytes(5)), { size: 50 })).rejects.toThrow();
    const after = (await store.get(KEY))!;
    expect(after.etag).toBe(before.etag);
    expect(await read(after.body)).toEqual(bytes(20));
  });

  it('a reader that already opened a blob keeps reading it while it is overwritten or deleted', async () => {
    await store.put(KEY, bytes(4000), { size: 4000 });
    const got = (await store.get(KEY))!;
    await store.put(KEY, bytes(10), { size: 10 });
    await store.delete(KEY);
    expect(await read(got.body)).toEqual(bytes(4000));
  });

  it('overwriting removes the previous data file; only one data file and one sidecar exist per key', async () => {
    for (let i = 0; i < 3; i++) await store.put(KEY, bytes(10 + i), { size: 10 + i });
    const files = storedFiles(dir);
    expect(files.filter((f) => f.endsWith('.json'))).toHaveLength(1);
    expect(files.filter((f) => !f.endsWith('.json'))).toHaveLength(1);
  });

  it('concurrent puts of one key end with one complete, consistent blob', async () => {
    await Promise.all(Array.from({ length: 8 }, (_, i) => store.put(KEY, bytes(100 + i), { size: 100 + i })));
    const got = (await store.get(KEY))!;
    expect(await read(got.body)).toEqual(bytes(got.size));
    expect(storedFiles(dir)).toHaveLength(2);
  });

  it('a data file whose size disagrees with its sidecar is not served', async () => {
    await store.put(KEY, bytes(100), { size: 100 });
    const data = storedFiles(dir).find((f) => !f.endsWith('.json'))!;
    writeFileSync(join(dir, data), bytes(50));
    expect(await store.get(KEY)).toBeNull();
    expect(await store.peek(KEY, 10)).toBeNull();
  });
});

describe('fs blob store: keys and layout', () => {
  it('accepts exactly the app\'s key shapes: originals, thumbnails, custom emoji', async () => {
    const thumb = thumbKeyOf(WS, '01JFILE0000000000000000000', '01JTHUMB000000000000000000');
    const emoji = emojiKey(WS, '01JEMOJI000000000000000000');
    expect(FILE_KEY_RE.test(thumb)).toBe(true);
    expect(EMOJI_KEY_RE.test(emoji)).toBe(true);
    for (const k of [KEY, thumb, emoji]) {
      await store.put(k, bytes(3), { size: 3 });
      expect(await store.peek(k, 3)).toEqual(bytes(3));
    }
  });

  it('rejects anything else (traversal, absolute paths, odd characters) without touching the disk', async () => {
    const bad = [
      '../../etc/passwd',
      '/etc/passwd',
      `${KEY}/../x`,
      `ws/${WS}/..`,
      `ws/${WS}/01JBL0B0000000000000000000\0`,
      `ws/${WS}/01jbl0b0000000000000000000`,
      `ws/${WS}/emoji/../01JBL0B0000000000000000000`,
      '',
      'ws',
      `${KEY}-missing`,
    ];
    for (const k of bad) {
      await expect(store.put(k, bytes(1), { size: 1 }), JSON.stringify(k)).rejects.toThrow('invalid blob key');
      await expect(store.get(k)).rejects.toThrow('invalid blob key');
      await expect(store.peek(k, 1)).rejects.toThrow('invalid blob key');
      await expect(store.delete([KEY, k])).rejects.toThrow('invalid blob key');
    }
    expect(storedFiles(dir)).toEqual([]);
  });

  it('the error for a bad key never contains the key', async () => {
    const e = (await store.get('../secret-key-value').catch((x: unknown) => x)) as Error;
    expect(e.message).not.toContain('secret-key-value');
  });

  it('stores each blob under a two-hex-character shard, with a JSON sidecar holding contentType, size and etag', async () => {
    await store.put(KEY, bytes(12), { contentType: 'image/gif', size: 12 });
    const files = storedFiles(dir);
    expect(files).toHaveLength(2);
    for (const f of files) expect(f).toMatch(/^[0-9a-f]{2}\/[^/]+$/);
    const sidecar = files.find((f) => f.endsWith('.json'))!;
    const meta = JSON.parse(readFileSync(join(dir, sidecar), 'utf8')) as Record<string, unknown>;
    const got = (await store.get(KEY))!;
    await read(got.body);
    expect(meta).toEqual({ contentType: 'image/gif', size: 12, etag: got.etag.slice(1, -1) });
    // The file name is derived from the key: no slashes, nothing that escapes the shard directory.
    expect(sidecar).not.toContain('..');
  });

  it('spreads keys over shards', async () => {
    for (let i = 0; i < 40; i++) await store.put(key(i), bytes(1), { size: 1 });
    const shards = new Set(storedFiles(dir).map((f) => f.slice(0, 2)));
    expect(shards.size).toBeGreaterThan(10);
  });

  it('creates its directory when missing', async () => {
    const nested = join(dir, 'a', 'b');
    const s = createFsBlobStore(nested);
    await s.put(KEY, bytes(1), { size: 1 });
    expect(existsSync(nested)).toBe(true);
  });
});

describe('getBlobStore', () => {
  it('an injected BLOB_STORE wins over BLOBS and BUCKET', () => {
    const injected = createFsBlobStore(dir);
    const fake = {} as never;
    expect(getBlobStore({ BLOB_STORE: injected, BLOBS: fake, BUCKET: fake })).toBe(injected);
    expect(getBlobStore({ BLOB_STORE: injected } as never)).toBe(injected);
    expect(() => getBlobStore({} as never)).toThrow('no blob storage binding');
  });
});
