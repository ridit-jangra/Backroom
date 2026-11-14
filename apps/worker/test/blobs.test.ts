import { env as rawEnv } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type BlobStore,
  STORAGE_BUSY_MESSAGE,
  etagMatches,
  getBlobStore,
  isKvLimitError,
  kvBlobStore,
  r2BlobStore,
  sliceStream,
} from '../src/lib/blobs';
import { ApiError } from '../src/lib/errors';
import { backendEnv, describeBackends, env, resetDb } from './helpers';

beforeEach(resetDb);

const KEY = 'ws/01JCLUBHACK0000000000000WS/01JBLOB0000000000000000000';
const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => i % 251);

async function read(s: ReadableStream | null): Promise<Uint8Array> {
  return new Uint8Array(await new Response(s).arrayBuffer());
}

function chunked(parts: number[][]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(Uint8Array.from(p));
      c.close();
    },
  });
}

describe('getBlobStore', () => {
  it('picks KV when BLOBS is bound, R2 when only BUCKET is, and fails with neither', async () => {
    const both = getBlobStore(rawEnv);
    await both.put(KEY, bytes(3), { size: 3 });
    expect(await rawEnv.BLOBS.get(KEY, 'arrayBuffer')).not.toBeNull();
    expect(await rawEnv.BUCKET!.head(KEY)).toBeNull();

    await getBlobStore(backendEnv('r2')).put(KEY, bytes(4), { size: 4 });
    expect((await rawEnv.BUCKET!.head(KEY))?.size).toBe(4);

    const none = { ...backendEnv('kv') } as Partial<Cloudflare.Env>;
    delete none.BLOBS;
    expect(() => getBlobStore(none as Cloudflare.Env)).toThrow();
  });
});

describeBackends('BlobStore', (backend) => {
  const store = (): BlobStore => getBlobStore(env);

  it('round-trips bytes with size, content type and a quoted etag', async () => {
    await store().put(KEY, bytes(1000), { contentType: 'image/png', size: 1000 });
    const got = await store().get(KEY);
    expect(got).not.toBeNull();
    expect(got!.notModified).toBe(false);
    expect(got!.size).toBe(1000);
    expect(got!.contentType).toBe('image/png');
    expect(got!.etag).toMatch(/^"[^"]+"$/);
    expect(got!.range).toBeUndefined();
    expect(await read(got!.body)).toEqual(bytes(1000));
  });

  it('accepts a stream body of known length; missing keys are null', async () => {
    const fixed = new FixedLengthStream(300);
    const piped = chunked([[...bytes(100)], [...bytes(200)]]).pipeTo(fixed.writable);
    await store().put(KEY, fixed.readable, { size: 300 });
    await piped;
    const got = await store().get(KEY);
    expect(got!.size).toBe(300);
    expect(got!.contentType).toBeNull();
    expect((await read(got!.body)).length).toBe(300);
    expect(await store().get(`${KEY}X`)).toBeNull();
    expect(await store().peek(`${KEY}X`, 10)).toBeNull();
  });

  // R2 etags are content hashes (same bytes, same etag); KV's are a random id per put.
  it.runIf(backend === 'kv')('a new put gets a new etag', async () => {
    await store().put(KEY, bytes(10), { size: 10 });
    const a = (await store().get(KEY))!;
    await read(a.body);
    await store().put(KEY, bytes(10), { size: 10 });
    const b = (await store().get(KEY))!;
    await read(b.body);
    expect(a.etag).not.toBe(b.etag);
  });

  it('range: offset/length and the suffix shape (last n bytes) return exactly those bytes', async () => {
    const data = bytes(5000);
    await store().put(KEY, data, { size: 5000 });
    const mid = (await store().get(KEY, { range: { offset: 1234, length: 100 } }))!;
    expect(mid.size).toBe(5000);
    expect(mid.range).toEqual({ offset: 1234, length: 100 });
    expect(await read(mid.body)).toEqual(data.subarray(1234, 1334));
    // parseRange turns `bytes=-500` into { offset: size - 500, length: 500 }
    const tail = (await store().get(KEY, { range: { offset: 4500, length: 500 } }))!;
    expect(await read(tail.body)).toEqual(data.subarray(4500));
    const first = (await store().get(KEY, { range: { offset: 0, length: 1 } }))!;
    expect(await read(first.body)).toEqual(data.subarray(0, 1));
  });

  it('If-None-Match: the stored etag (strong, weak, in a list, or *) is notModified without a body', async () => {
    await store().put(KEY, bytes(64), { contentType: 'image/webp', size: 64 });
    const full = (await store().get(KEY))!;
    await read(full.body);
    for (const h of [full.etag, `W/${full.etag}`, `"zzz", ${full.etag}`, '*']) {
      const r = (await store().get(KEY, { ifNoneMatch: h }))!;
      expect(r.notModified, h).toBe(true);
      expect(r.body).toBeNull();
      expect(r.etag).toBe(full.etag);
      expect(r.size).toBe(64);
    }
    const ranged = (await store().get(KEY, { ifNoneMatch: full.etag, range: { offset: 0, length: 8 } }))!;
    expect(ranged.notModified).toBe(true);
  });

  it('If-None-Match: another etag, or a malformed validator, serves the body', async () => {
    await store().put(KEY, bytes(64), { size: 64 });
    for (const h of ['"nope"', 'abc', 'W/', '""']) {
      const r = (await store().get(KEY, { ifNoneMatch: h }))!;
      expect(r.notModified, h).toBe(false);
      expect(await read(r.body)).toEqual(bytes(64));
    }
  });

  it('peek returns at most the first n bytes', async () => {
    await store().put(KEY, bytes(500), { size: 500 });
    expect(await store().peek(KEY, 16)).toEqual(bytes(16));
    expect(await store().peek(KEY, 10_000)).toEqual(bytes(500));
  });

  it('delete takes one key or several; missing keys are fine', async () => {
    const keys = ['a', 'b', 'c'].map((s) => `${KEY}-${s}`);
    for (const k of keys) await store().put(k, bytes(1), { size: 1 });
    await store().delete(keys[0]!);
    expect(await store().get(keys[0]!)).toBeNull();
    await store().delete([keys[1]!, keys[2]!, `${KEY}-missing`]);
    for (const k of keys) expect(await store().get(k), `${backend} ${k}`).toBeNull();
  });
});

describe('sliceStream', () => {
  it('slices across chunk boundaries and stops reading once the range is served', async () => {
    let pulls = 0;
    const src = new ReadableStream<Uint8Array>({
      pull(c) {
        pulls++;
        c.enqueue(Uint8Array.from([pulls * 10, pulls * 10 + 1, pulls * 10 + 2]));
        if (pulls === 100) c.close();
      },
    });
    // chunks: [10,11,12] [20,21,22] [30,31,32] ...; offset 2, length 5 → 12 20 21 22 30
    expect([...(await read(sliceStream(src, 2, 5)))]).toEqual([12, 20, 21, 22, 30]);
    expect(pulls).toBeLessThan(10);
  });

  it('offset 0 / whole length, and an exact chunk edge', async () => {
    expect([...(await read(sliceStream(chunked([[1, 2], [3, 4]]), 0, 4)))]).toEqual([1, 2, 3, 4]);
    expect([...(await read(sliceStream(chunked([[1, 2], [3, 4]]), 2, 2)))]).toEqual([3, 4]);
  });

  it('a source shorter than the range errors instead of serving a short body', async () => {
    await expect(read(sliceStream(chunked([[1, 2, 3]]), 1, 10))).rejects.toThrow();
  });
});

describe('etagMatches', () => {
  it('compares opaque tags weakly, accepts lists and *, rejects junk', () => {
    expect(etagMatches('"abc"', 'abc')).toBe(true);
    expect(etagMatches('W/"abc"', 'abc')).toBe(true);
    expect(etagMatches(' "x" ,  "abc" ', 'abc')).toBe(true);
    expect(etagMatches('*', 'abc')).toBe(true);
    expect(etagMatches('abc', 'abc')).toBe(false);
    expect(etagMatches('"abcd"', 'abc')).toBe(false);
    expect(etagMatches('', 'abc')).toBe(false);
  });
});

describe('KV daily limits', () => {
  const limitError = () => new Error('KV put() limit exceeded for the day.');

  /** A fake namespace whose every call fails the way the free tier does after the daily cap. */
  function exhausted(err: () => unknown = limitError): KVNamespace {
    const fail = async () => {
      throw err();
    };
    return { get: fail, getWithMetadata: fail, put: fail, delete: fail, list: fail } as unknown as KVNamespace;
  }

  it('recognises "limit exceeded" messages and HTTP 429 errors, nothing else', () => {
    expect(isKvLimitError(limitError())).toBe(true);
    expect(isKvLimitError(new Error('KV delete() limit exceeded for the day.'))).toBe(true);
    expect(isKvLimitError(Object.assign(new Error('Too Many Requests'), { status: 429 }))).toBe(true);
    expect(isKvLimitError(new Error('429 Too Many Requests'))).toBe(true);
    expect(isKvLimitError(new Error('network down'))).toBe(false);
    expect(isKvLimitError('limit exceeded')).toBe(false);
  });

  it('put, get, peek and delete map the limit to 503 storage_busy; other errors pass through', async () => {
    const s = kvBlobStore(exhausted());
    for (const call of [
      () => s.put(KEY, bytes(1), { size: 1 }),
      () => s.get(KEY),
      () => s.peek(KEY, 1),
      () => s.delete([KEY, `${KEY}2`]),
    ]) {
      const e = await call().catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ApiError);
      expect(e).toMatchObject({ status: 503, code: 'storage_busy', message: STORAGE_BUSY_MESSAGE });
    }
    expect(STORAGE_BUSY_MESSAGE).toBe('Storage is at its daily write limit. Try again tomorrow.');
    const other = await kvBlobStore(exhausted(() => new Error('boom')))
      .put(KEY, bytes(1), { size: 1 })
      .catch((x: unknown) => x);
    expect(other).not.toBeInstanceOf(ApiError);
  });

  it('delete loops key by key, tries every key on ordinary errors, stops at the limit', async () => {
    const seen: string[] = [];
    const flaky = {
      delete: async (k: string) => {
        seen.push(k);
        if (k === 'b') throw new Error('flaky');
      },
    } as unknown as KVNamespace;
    await expect(kvBlobStore(flaky).delete(['a', 'b', 'c'])).rejects.toThrow('flaky');
    expect(seen).toEqual(['a', 'b', 'c']);

    seen.length = 0;
    const capped = {
      delete: async (k: string) => {
        seen.push(k);
        if (k === 'b') throw new Error('KV delete() limit exceeded for the day.');
      },
    } as unknown as KVNamespace;
    await expect(kvBlobStore(capped).delete(['a', 'b', 'c'])).rejects.toMatchObject({ code: 'storage_busy' });
    expect(seen).toEqual(['a', 'b']);
  });

  it('the R2 adapter never reports storage_busy', async () => {
    const failing = {
      put: async () => {
        throw new Error('limit exceeded');
      },
    } as unknown as R2Bucket;
    const e = await r2BlobStore(failing).put(KEY, bytes(1), { size: 1 }).catch((x: unknown) => x);
    expect(e).not.toBeInstanceOf(ApiError);
  });
});
