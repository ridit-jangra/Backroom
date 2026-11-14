import type { Env } from '../env';
import { ApiError } from './errors';

/**
 * Blob storage behind one small interface, so the app runs on Workers KV (free, no payment card), R2, or a store the
 * host injects as `BLOB_STORE` (the Node server's filesystem store, apps/server/src/platform/fs-blobs.ts).
 * `getBlobStore` picks an injected `BLOB_STORE` first, then KV whenever `BLOBS` is bound, otherwise R2 over `BUCKET`.
 *
 * Etags: the R2 adapter returns R2's `httpEtag`. The KV adapter stores a random id per put in the value's metadata
 * (never a hash of the bytes: hashing 25 MB would blow the 10 ms CPU limit) and returns it quoted, the same shape.
 */

export type BlobRange = { offset: number; length: number };

export type BlobGetResult = {
  /** null exactly when `notModified`. With a range, only the range's bytes. */
  body: ReadableStream | null;
  /** Size of the whole blob, also for a range. */
  size: number;
  /** Quoted entity tag, ready for an `ETag` header. */
  etag: string;
  contentType: string | null;
  range?: BlobRange;
  /** `ifNoneMatch` matched the stored etag: no body (the caller answers 304). */
  notModified: boolean;
};

export interface BlobStore {
  /**
   * True when a `put` that the store itself rejected (with an intact body) wrote nothing, so callers skip the
   * cleanup delete and do not spend one of KV's capped daily deletes. False for R2, which keeps the safety delete.
   * It says nothing about a body that broke mid-stream: local KV keeps the partial value then, so that is always
   * cleaned up.
   */
  readonly failedPutLeavesNothing: boolean;
  /** `size` is the body's exact length; a stream body must deliver exactly that many bytes (FixedLengthStream). */
  put(key: string, body: ReadableStream | Uint8Array | ArrayBuffer, opts: { contentType?: string; size: number }): Promise<void>;
  /** null when the key does not exist. A malformed `ifNoneMatch` is ignored (the blob is served). */
  get(key: string, opts?: { range?: BlobRange; ifNoneMatch?: string }): Promise<BlobGetResult | null>;
  /** One key or several. KV has no batch delete, so its adapter deletes them one by one. */
  delete(keys: string | string[]): Promise<void>;
  /** The first `length` bytes (fewer if the blob is shorter), or null when the key does not exist. */
  peek(key: string, length: number): Promise<Uint8Array | null>;
}

/** Metadata stored with every KV value (well under KV's 1 KB metadata limit). */
export type KvBlobMeta = { contentType: string | null; size: number; etag: string };

export const STORAGE_BUSY_MESSAGE = 'Storage has reached a free-tier limit. Try again later.';
export const storageBusy = () => new ApiError(503, 'storage_busy', STORAGE_BUSY_MESSAGE);
export const isStorageBusy = (e: unknown): boolean => e instanceof ApiError && e.code === 'storage_busy';

/**
 * Best-effort delete for cleanup paths outside the cron; never throws. At the KV daily limit the blob stays behind:
 * logged as `blob_leaked` with its class only (never the key). Any other failure is logged as `failCode`.
 */
export async function deleteOrLog(store: BlobStore, key: string, kind: 'file' | 'thumb' | 'emoji', failCode: string): Promise<void> {
  try {
    await store.delete(key);
  } catch (e) {
    if (isStorageBusy(e)) console.warn(JSON.stringify({ level: 'warn', code: 'blob_leaked', kind }));
    else console.error(JSON.stringify({ level: 'error', code: failCode }));
  }
}

/**
 * The free tier's daily caps (1,000 writes, 1,000 deletes, 100,000 reads) surface as an error whose message says
 * "limit exceeded" (e.g. "KV put() limit exceeded for the day."), or as HTTP 429.
 */
export function isKvLimitError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if ((e as { status?: unknown }).status === 429) return true;
  return /limit exceeded|\b429\b/i.test(e.message);
}

/** Runs a KV call, turning a daily-limit failure into `503 storage_busy`; anything else is rethrown as is. */
async function kvCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (isKvLimitError(e)) throw storageBusy();
    throw e;
  }
}

const ETAG_RE = /^(?:W\/)?"([^"]*)"$/;

/**
 * RFC 9110 If-None-Match (weak comparison): `*`, or a comma-separated list of entity tags, one of which equals
 * `etag` (the unquoted stored value). Anything malformed matches nothing, so the blob is served.
 */
export function etagMatches(header: string, etag: string): boolean {
  const h = header.trim();
  if (h === '*') return true;
  return h.split(',').some((part) => {
    const m = ETAG_RE.exec(part.trim());
    return m !== null && m[1] === etag;
  });
}

/**
 * The bytes [offset, offset + length) of `src`, as a stream of exactly `length` bytes. Skipped chunks are dropped
 * as they arrive; once the range is complete the source is cancelled, so the rest is never read. A source that
 * ends early errors the stream rather than serving a short body.
 */
export function sliceStream(src: ReadableStream<Uint8Array>, offset: number, length: number): ReadableStream<Uint8Array> {
  const reader = src.getReader();
  let skip = offset;
  let left = length;
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      if (left === 0) {
        ctrl.close();
        await reader.cancel().catch(() => {});
        return;
      }
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          ctrl.error(new Error('blob ended before the requested range'));
          return;
        }
        let chunk = value;
        if (skip > 0) {
          if (chunk.byteLength <= skip) {
            skip -= chunk.byteLength;
            continue;
          }
          chunk = chunk.subarray(skip);
          skip = 0;
        }
        if (chunk.byteLength > left) chunk = chunk.subarray(0, left);
        left -= chunk.byteLength;
        ctrl.enqueue(chunk);
        if (left === 0) {
          ctrl.close();
          await reader.cancel().catch(() => {});
        }
        return;
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** Reads the first `length` bytes of a stream, then cancels it. */
async function readHead(src: ReadableStream<Uint8Array>, length: number): Promise<Uint8Array> {
  const out = new Uint8Array(length);
  let filled = 0;
  const reader = src.getReader();
  try {
    while (filled < length) {
      const { done, value } = await reader.read();
      if (done) break;
      const n = Math.min(value.byteLength, length - filled);
      out.set(value.subarray(0, n), filled);
      filled += n;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return out.subarray(0, filled);
}

function isMeta(m: unknown): m is KvBlobMeta {
  if (typeof m !== 'object' || m === null) return false;
  const o = m as Record<string, unknown>;
  return typeof o.size === 'number' && typeof o.etag === 'string' && (o.contentType === null || typeof o.contentType === 'string');
}

/**
 * Workers KV adapter. Values are at most 25 MiB (= FILE_MAX_BYTES). KV is eventually consistent across
 * locations, but a write is visible at once at the location that made it, which is all the upload path needs
 * (put, then peek for sniffing, in the same request).
 */
export function kvBlobStore(ns: KVNamespace): BlobStore {
  return {
    failedPutLeavesNothing: true,

    async put(key, body, opts) {
      const metadata: KvBlobMeta = { contentType: opts.contentType ?? null, size: opts.size, etag: crypto.randomUUID().replaceAll('-', '') };
      await kvCall(() => ns.put(key, body, { metadata }));
    },

    async get(key, opts = {}) {
      const r = await kvCall(() => ns.getWithMetadata<KvBlobMeta>(key, { type: 'stream' }));
      if (r.value === null) return null;
      if (!isMeta(r.metadata)) {
        // Every value this app writes carries metadata; anything else is not ours to serve.
        await r.value.cancel().catch(() => {});
        return null;
      }
      const { size, contentType } = r.metadata;
      const etag = `"${r.metadata.etag}"`;
      if (opts.ifNoneMatch !== undefined && etagMatches(opts.ifNoneMatch, r.metadata.etag)) {
        await r.value.cancel().catch(() => {});
        return { body: null, size, etag, contentType, notModified: true };
      }
      if (opts.range) {
        // No native range reads: stream from the start and serve only the requested slice.
        const body = sliceStream(r.value, opts.range.offset, opts.range.length);
        return { body, size, etag, contentType, range: opts.range, notModified: false };
      }
      return { body: r.value, size, etag, contentType, notModified: false };
    },

    async delete(keys) {
      let firstError: unknown;
      for (const key of typeof keys === 'string' ? [keys] : keys) {
        try {
          await kvCall(() => ns.delete(key));
        } catch (e) {
          if (e instanceof ApiError) throw e; // daily limit: every further delete would fail too
          firstError ??= e;
        }
      }
      if (firstError !== undefined) throw firstError;
    },

    async peek(key, length) {
      const v = await kvCall(() => ns.get(key, { type: 'stream' }));
      return v === null ? null : readHead(v, length);
    },
  };
}

/** R2 adapter: native range and conditional reads, batch delete. */
export function r2BlobStore(bucket: R2Bucket): BlobStore {
  const hasBody = (o: R2Object | R2ObjectBody): o is R2ObjectBody => 'body' in o;
  return {
    failedPutLeavesNothing: false,

    async put(key, body, opts) {
      await bucket.put(key, body, opts.contentType === undefined ? undefined : { httpMetadata: { contentType: opts.contentType } });
    },

    async get(key, opts = {}) {
      const { range, ifNoneMatch } = opts;
      let obj: R2Object | R2ObjectBody | null;
      if (ifNoneMatch === undefined) {
        obj = await bucket.get(key, { range });
      } else {
        try {
          obj = await bucket.get(key, { onlyIf: new Headers({ 'If-None-Match': ifNoneMatch }), range });
        } catch {
          // A malformed validator makes the conditional get throw; it must not 500 (P3-R16): serve unconditionally.
          obj = await bucket.get(key, { range });
        }
      }
      if (!obj) return null;
      const base = { size: obj.size, etag: obj.httpEtag, contentType: obj.httpMetadata?.contentType ?? null };
      // A conditional get whose precondition failed returns the object without a body: the etag matched.
      if (!hasBody(obj)) return { ...base, body: null, notModified: true };
      return { ...base, body: obj.body, notModified: false, ...(range ? { range } : {}) };
    },

    async delete(keys) {
      await bucket.delete(keys);
    },

    async peek(key, length) {
      const obj = await bucket.get(key, { range: { offset: 0, length } });
      return obj ? obj.bytes() : null;
    },
  };
}

/** An injected `BLOB_STORE` (the Node server), else KV when `BLOBS` is bound (Workers production), else R2 over `BUCKET`. */
export function getBlobStore(env: Pick<Env, 'BLOBS' | 'BUCKET' | 'BLOB_STORE'>): BlobStore {
  if (env.BLOB_STORE) return env.BLOB_STORE;
  if (env.BLOBS) return kvBlobStore(env.BLOBS);
  if (env.BUCKET) return r2BlobStore(env.BUCKET);
  throw new Error('no blob storage binding (BLOBS or BUCKET)');
}
