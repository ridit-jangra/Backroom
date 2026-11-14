import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { type FileHandle, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { FILE_KEY_RE } from '../../../worker/src/files/store';
import { type BlobRange, type BlobStore, type KvBlobMeta, etagMatches } from '../../../worker/src/lib/blobs';

/**
 * Filesystem blob store (the Node server's replacement for KV/R2), same `BlobStore` semantics as the Workers
 * adapters.
 *
 * Layout: `<dir>/<shard>/<name>.json` is the sidecar `{ contentType, size, etag }` and `<dir>/<shard>/<name>.<etag>`
 * the bytes. `<name>` is the key with `/` turned into `~` (keys are validated, so the name is unambiguous and can
 * never contain a path separator or `..`); `<shard>` is the first two hex digits of sha256(key), 256 directories.
 *
 * Writes are atomic: bytes stream into a temp file under `<dir>/.tmp`, are counted against the declared size and
 * fsynced, then renamed to a fresh, never-reused data file name (the etag is a random id per put). The sidecar is
 * written the same way, and its rename is the commit point: readers only ever follow a sidecar to a complete data
 * file. A failed, short, long or aborted upload removes its temp file, so it leaves nothing behind (and an
 * overwrite that fails keeps the previous blob). After the commit the previous data file is removed. A crash
 * between the two renames leaves only an unreferenced data file, never a broken blob.
 *
 * Reads open the data file before returning, so a blob that is overwritten or deleted while being streamed keeps
 * serving the bytes the reader started with. Ranges are native (positioned reads of `offset`..`offset+length-1`).
 */

/** A custom emoji image key (`emojiKey` in emoji/custom.ts). File keys use FILE_KEY_RE from files/store.ts. */
export const EMOJI_KEY_RE = /^ws\/[0-9A-Z]{26}\/emoji\/[0-9A-Z]{26}$/;

const isValidKey = (key: unknown): key is string => typeof key === 'string' && (FILE_KEY_RE.test(key) || EMOJI_KEY_RE.test(key));

class InvalidKeyError extends TypeError {
  constructor() {
    super('invalid blob key'); // never the key itself
    this.name = 'InvalidKeyError';
  }
}

function assertKey(key: unknown): asserts key is string {
  if (!isValidKey(key)) throw new InvalidKeyError();
}

const isMissing = (e: unknown): boolean => (e as NodeJS.ErrnoException | null)?.code === 'ENOENT';

function isMeta(m: unknown): m is KvBlobMeta {
  if (typeof m !== 'object' || m === null) return false;
  const o = m as Record<string, unknown>;
  return (
    typeof o.size === 'number' &&
    Number.isSafeInteger(o.size) &&
    o.size >= 0 &&
    typeof o.etag === 'string' &&
    /^[0-9a-f]{32}$/.test(o.etag) &&
    (o.contentType === null || typeof o.contentType === 'string')
  );
}

const lengthMismatch = () => new TypeError('blob body length does not match its declared size');

export function createFsBlobStore(dir: string): BlobStore {
  const tmpDir = join(dir, '.tmp');
  let ready: Promise<unknown> | null = null;
  const ensureTmp = () => (ready ??= mkdir(tmpDir, { recursive: true }).catch((e: unknown) => {
    ready = null;
    throw e;
  }));

  const paths = (key: string) => {
    const shard = createHash('sha256').update(key).digest('hex').slice(0, 2);
    const base = join(dir, shard, key.replaceAll('/', '~'));
    return { shardDir: join(dir, shard), sidecar: `${base}.json`, data: (etag: string) => `${base}.${etag}` };
  };

  /** Per-key queue so puts and deletes of one key run one after another (reads never wait). */
  const locks = new Map<string, Promise<unknown>>();
  function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    locks.set(key, tail);
    void tail.then(() => {
      if (locks.get(key) === tail) locks.delete(key);
    });
    return run;
  }

  async function readMeta(sidecar: string): Promise<KvBlobMeta | null> {
    let text: string;
    try {
      text = await readFile(sidecar, 'utf8');
    } catch (e) {
      if (isMissing(e)) return null;
      throw e;
    }
    let meta: unknown;
    try {
      meta = JSON.parse(text);
    } catch {
      meta = null;
    }
    if (!isMeta(meta)) {
      console.error(JSON.stringify({ level: 'error', code: 'blob_sidecar_invalid' }));
      return null;
    }
    return meta;
  }

  /** The sidecar and an open handle on its data file, or null when the blob does not exist (or is inconsistent). */
  async function openBlob(key: string): Promise<{ meta: KvBlobMeta; fh: FileHandle } | null> {
    const p = paths(key);
    // A put or delete can replace the files between reading the sidecar and opening the data file; retry then.
    for (let attempt = 0; attempt < 3; attempt++) {
      const meta = await readMeta(p.sidecar);
      if (meta === null) return null;
      let fh: FileHandle;
      try {
        fh = await open(p.data(meta.etag), 'r');
      } catch (e) {
        if (isMissing(e)) continue;
        throw e;
      }
      const { size } = await fh.stat();
      if (size !== meta.size) {
        await fh.close();
        console.error(JSON.stringify({ level: 'error', code: 'blob_size_mismatch' }));
        return null;
      }
      return { meta, fh };
    }
    return null;
  }

  /** Writes `chunks` to a fresh temp file, fsyncs it and returns its path; removes it on any failure. */
  async function writeTemp(chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, expected: number | null): Promise<string> {
    await ensureTmp();
    const tmp = join(tmpDir, `${randomUUID()}.tmp`);
    const fh = await open(tmp, 'wx', 0o600);
    try {
      let written = 0;
      for await (const chunk of chunks) {
        written += chunk.byteLength;
        if (expected !== null && written > expected) throw lengthMismatch();
        let off = 0;
        while (off < chunk.byteLength) {
          const { bytesWritten } = await fh.write(chunk, off, chunk.byteLength - off);
          off += bytesWritten;
        }
      }
      if (expected !== null && written !== expected) throw lengthMismatch();
      await fh.datasync();
      await fh.close();
      return tmp;
    } catch (e) {
      await fh.close().catch(() => {});
      await unlink(tmp).catch(() => {});
      throw e;
    }
  }

  async function* streamChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
    const reader = body.getReader();
    let finished = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          finished = true;
          return;
        }
        yield value;
      }
    } finally {
      // Stopped early (too many bytes, disk error): cancel the source so the client stops sending.
      if (!finished) await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  async function fsyncDir(path: string): Promise<void> {
    const fh = await open(path, 'r').catch(() => null);
    if (!fh) return;
    await fh.sync().catch(() => {});
    await fh.close();
  }

  async function removeBlob(key: string): Promise<void> {
    const p = paths(key);
    const meta = await readMeta(p.sidecar);
    try {
      await unlink(p.sidecar); // the blob is gone from here on
    } catch (e) {
      if (!isMissing(e)) throw e;
    }
    if (meta) await unlink(p.data(meta.etag)).catch((e: unknown) => {
      if (!isMissing(e)) throw e;
    });
  }

  return {
    failedPutLeavesNothing: true,

    async put(key, body, opts) {
      assertKey(key);
      const size = opts.size;
      if (!Number.isSafeInteger(size) || size < 0) throw new TypeError('blob size must be a non-negative integer');
      let chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
      if (body instanceof ArrayBuffer) chunks = [new Uint8Array(body)];
      else if (body instanceof Uint8Array) chunks = [body];
      else chunks = streamChunks(body as ReadableStream<Uint8Array>);

      const tmpData = await writeTemp(chunks, size);
      return withLock(key, async () => {
        const p = paths(key);
        const etag = randomUUID().replaceAll('-', '');
        const meta: KvBlobMeta = { contentType: opts.contentType ?? null, size, etag };
        let tmpMeta: string | null = null;
        try {
          await mkdir(p.shardDir, { recursive: true });
          tmpMeta = await writeTemp([new TextEncoder().encode(JSON.stringify(meta))], null);
          const previous = await readMeta(p.sidecar);
          await rename(tmpData, p.data(etag));
          try {
            await rename(tmpMeta, p.sidecar); // commit
          } catch (e) {
            await unlink(p.data(etag)).catch(() => {});
            throw e;
          }
          tmpMeta = null;
          await fsyncDir(p.shardDir);
          if (previous && previous.etag !== etag) await unlink(p.data(previous.etag)).catch(() => {});
        } finally {
          await unlink(tmpData).catch(() => {}); // no-op once renamed
          if (tmpMeta) await unlink(tmpMeta).catch(() => {});
        }
      });
    },

    async get(key, opts = {}) {
      assertKey(key);
      const { range, ifNoneMatch } = opts;
      if (range) checkRange(range);
      const blob = await openBlob(key);
      if (!blob) return null;
      const { meta, fh } = blob;
      const base = { size: meta.size, etag: `"${meta.etag}"`, contentType: meta.contentType };
      if (ifNoneMatch !== undefined && etagMatches(ifNoneMatch, meta.etag)) {
        await fh.close();
        return { ...base, body: null, notModified: true };
      }
      if (range && range.offset + range.length > meta.size) {
        await fh.close();
        throw new RangeError('range outside the blob');
      }
      const start = range?.offset ?? 0;
      const length = range?.length ?? meta.size;
      const body = fileStream(fh, start, length);
      return { ...base, body, notModified: false, ...(range ? { range } : {}) };
    },

    async delete(keys) {
      const list = typeof keys === 'string' ? [keys] : keys;
      for (const k of list) assertKey(k);
      let firstError: unknown;
      for (const k of list) {
        try {
          await withLock(k, () => removeBlob(k));
        } catch (e) {
          firstError ??= e;
        }
      }
      if (firstError !== undefined) throw firstError;
    },

    async peek(key, length) {
      assertKey(key);
      const blob = await openBlob(key);
      if (!blob) return null;
      const { meta, fh } = blob;
      try {
        const want = Math.max(0, Math.min(length, meta.size));
        const out = new Uint8Array(want);
        let filled = 0;
        while (filled < want) {
          const { bytesRead } = await fh.read(out, filled, want - filled, filled);
          if (bytesRead === 0) break;
          filled += bytesRead;
        }
        return out.subarray(0, filled);
      } finally {
        await fh.close();
      }
    },
  };
}

function checkRange(r: BlobRange): void {
  if (!Number.isSafeInteger(r.offset) || !Number.isSafeInteger(r.length) || r.offset < 0 || r.length < 0) {
    throw new RangeError('invalid range');
  }
}

/** Exactly `length` bytes from `start` as a web stream; closes the handle when done or cancelled. */
function fileStream(fh: FileHandle, start: number, length: number): ReadableStream<Uint8Array> {
  if (length === 0) {
    void fh.close();
    return new ReadableStream({ start: (c) => c.close() });
  }
  const node = createReadStream('', { fd: fh, start, end: start + length - 1, autoClose: true });
  return Readable.toWeb(node) as unknown as ReadableStream<Uint8Array>;
}
