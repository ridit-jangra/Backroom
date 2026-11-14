import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { type FileHandle, mkdir, open, readFile, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
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
 * Reads are lazy: `get()` only reads the sidecar and stats the data file. The returned body opens the data file on
 * its first pull and closes it at the end, on error and on cancel, so a body that is never read (Hono's HEAD
 * handling drops it) holds nothing open. That matters: on Node 26 an open FileHandle that gets garbage collected is
 * an uncaught ERR_INVALID_STATE that kills the process. Data files are immutable and named by etag, so a reader
 * that has started keeps its bytes across an overwrite or delete (positioned reads on its own handle after the
 * unlink); a blob replaced before the first read errors the stream instead. Ranges are native positioned reads.
 *
 * `sweepBlobDir` removes crash leftovers at startup.
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

  /** The sidecar of an existing, consistent blob (data file present with the recorded size), or null. */
  async function statBlob(key: string): Promise<KvBlobMeta | null> {
    const p = paths(key);
    // Retry: a put or delete can replace the files between reading the sidecar and looking at the data file.
    for (let attempt = 0; attempt < 3; attempt++) {
      const meta = await readMeta(p.sidecar);
      if (meta === null) return null;
      let size: number;
      try {
        size = (await stat(p.data(meta.etag))).size;
      } catch (e) {
        if (isMissing(e)) continue;
        throw e;
      }
      if (size !== meta.size) {
        console.error(JSON.stringify({ level: 'error', code: 'blob_size_mismatch' }));
        return null;
      }
      return meta;
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
          try {
            await fsyncDir(p.shardDir);
          } catch (e) {
            // Not durable: undo the commit so a failed put still leaves nothing (sweepBlobDir collects the rest).
            await unlink(p.sidecar).catch(() => {});
            await unlink(p.data(etag)).catch(() => {});
            throw e;
          }
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
      const meta = await statBlob(key);
      if (!meta) return null;
      const base = { size: meta.size, etag: `"${meta.etag}"`, contentType: meta.contentType };
      if (ifNoneMatch !== undefined && etagMatches(ifNoneMatch, meta.etag)) return { ...base, body: null, notModified: true };
      if (range && range.offset + range.length > meta.size) throw new RangeError('range outside the blob');
      const start = range?.offset ?? 0;
      const length = range?.length ?? meta.size;
      const body = lazyFileStream(paths(key).data(meta.etag), meta.size, start, length);
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
      const meta = await statBlob(key);
      if (!meta) return null;
      let fh: FileHandle;
      try {
        fh = await open(paths(key).data(meta.etag), 'r');
      } catch (e) {
        if (isMissing(e)) return null; // replaced or deleted since the stat
        throw e;
      }
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

const READ_CHUNK = 64 * 1024;

/** fs errors carry the file path, which contains the key: replace them with a path-free message. */
function streamError(e: unknown): Error {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOENT') return new Error('blob no longer exists');
  if (code !== undefined) return new Error(`blob read failed (${code})`);
  return e instanceof Error ? e : new Error('blob read failed');
}

const openFd = promisify(fs.open);
const readFd = promisify(fs.read);
const fstatFd = promisify(fs.fstat);

/**
 * Closes the fd of a body stream that was dropped while open (read part way, never cancelled). A raw fd, not a
 * FileHandle: a collected FileHandle is a fatal ERR_INVALID_STATE on Node 26, a collected number is just closed here.
 */
const abandoned = new FinalizationRegistry<number>((fd) => fs.close(fd, () => {}));

/**
 * Exactly `length` bytes of the file at `path` from `start`, as a web stream that opens the file on its first pull
 * (highWaterMark 0: nothing is read ahead) and closes it on end, error and cancel, or when the stream is garbage
 * collected while open. A file that is gone, or whose size is no longer `size`, errors the stream; so does a file
 * that ends early.
 */
function lazyFileStream(path: string, size: number, start: number, length: number): ReadableStream<Uint8Array> {
  let fd: number | null = null;
  let pos = start;
  let left = length;
  let cancelled = false;
  const token = {};
  const close = () => {
    const f = fd;
    fd = null;
    if (f !== null) {
      abandoned.unregister(token);
      fs.close(f, () => {});
    }
  };
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(ctrl) {
        try {
          if (left === 0) {
            close();
            ctrl.close();
            return;
          }
          if (fd === null) {
            const f = await openFd(path, 'r');
            if (cancelled) {
              fs.close(f, () => {});
              return;
            }
            fd = f;
            abandoned.register(stream, f, token);
            if ((await fstatFd(f)).size !== size) throw new Error('blob changed before it was read');
          }
          const buf = new Uint8Array(Math.min(left, READ_CHUNK));
          const { bytesRead } = await readFd(fd, buf, 0, buf.byteLength, pos);
          if (cancelled) {
            close();
            return;
          }
          if (bytesRead === 0) throw new Error('blob ended before the requested range');
          pos += bytesRead;
          left -= bytesRead;
          ctrl.enqueue(buf.subarray(0, bytesRead));
          if (left === 0) {
            close();
            ctrl.close();
          }
        } catch (e) {
          close();
          ctrl.error(streamError(e));
        }
      },
      cancel() {
        cancelled = true;
        close();
      },
    },
    { highWaterMark: 0 },
  );
  return stream;
}

/** errno codes meaning "this filesystem cannot fsync a directory": skipped. Every other failure is real. */
const DIR_SYNC_UNSUPPORTED = new Set(['EINVAL', 'EISDIR', 'ENOTSUP', 'EOPNOTSUPP']);

/** fsyncs a directory so the renames in it are durable; `openFn` is injectable for tests. */
export async function fsyncDir(path: string, openFn: (p: string, flags: string) => Promise<FileHandle> = open): Promise<void> {
  const fh = await openFn(path, 'r');
  try {
    await fh.sync();
  } catch (e) {
    if (!DIR_SYNC_UNSUPPORTED.has((e as NodeJS.ErrnoException).code ?? '')) throw e;
  } finally {
    await fh.close();
  }
}

const SHARD_RE = /^[0-9a-f]{2}$/;
const DATA_RE = /^(.+)\.([0-9a-f]{32})$/;
const SIDECAR_RE = /^(.+)\.json$/;

/**
 * Startup cleanup (call before serving, with no puts running): removes `.tmp` leftovers, data files that no sidecar
 * names (a put that crashed between its renames, or an overwrite that died before removing the old file), and
 * sidecars whose data file is missing or which are unreadable. Returns the counts; never logs names (they hold keys).
 */
export async function sweepBlobDir(dir: string): Promise<{ tempFiles: number; orphanData: number; danglingSidecars: number }> {
  const out = { tempFiles: 0, orphanData: 0, danglingSidecars: 0 };
  let top: string[];
  try {
    top = await readdir(dir);
  } catch (e) {
    if (isMissing(e)) return out;
    throw e;
  }
  if (top.includes('.tmp')) {
    for (const f of await readdir(join(dir, '.tmp'))) {
      await rm(join(dir, '.tmp', f), { recursive: true, force: true });
      out.tempFiles++;
    }
  }
  for (const shard of top) {
    if (!SHARD_RE.test(shard)) continue;
    const shardDir = join(dir, shard);
    const names = await readdir(shardDir);
    const present = new Set(names);
    const live = new Set<string>();
    for (const n of names) {
      const m = SIDECAR_RE.exec(n);
      if (!m) continue;
      let meta: unknown = null;
      try {
        meta = JSON.parse(await readFile(join(shardDir, n), 'utf8'));
      } catch {
        meta = null;
      }
      const dataName = isMeta(meta) ? `${m[1]}.${meta.etag}` : null;
      if (dataName && present.has(dataName)) live.add(dataName);
      else {
        await unlink(join(shardDir, n)).catch(() => {});
        out.danglingSidecars++;
      }
    }
    for (const n of names) {
      if (SIDECAR_RE.test(n) || !DATA_RE.test(n) || live.has(n)) continue;
      await unlink(join(shardDir, n)).catch(() => {});
      out.orphanData++;
    }
  }
  return out;
}
