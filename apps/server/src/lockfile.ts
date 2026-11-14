/**
 * Exclusive lock files: `DATA_DIR/server.lock` (one server per data directory, held for the server's lifetime) and
 * `DATA_DIR/maintenance.lock` (one maintenance run at a time).
 *
 * Created with O_EXCL. The file records the holder's pid, its process start time (Linux /proc) and a random token.
 * A lock is stale when its process is gone, when it names this process but not a lock this process holds (a reused
 * pid, e.g. pid 1 after a container restart), when the pid is alive but started at another time (pid reuse), or,
 * with `staleMs`, when it is older than that. A stale lock is renamed aside (atomic: one contender wins) and the
 * O_EXCL create is retried; it is never unlinked in place, which could delete a lock just taken by someone else.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { link, open, readFile, rename, stat, unlink } from 'node:fs/promises';

export interface Lock {
  release(): Promise<void>;
  /** For process 'exit' handlers. */
  releaseSync(): void;
}

interface LockInfo {
  pid?: unknown;
  start?: unknown;
  at?: unknown;
  token?: unknown;
}

/** Tokens of the locks this process holds. */
const held = new Set<string>();

/** The process's start time in clock ticks since boot (field 22 of /proc/<pid>/stat), or null without /proc. */
export function processStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === 'EPERM';
  }
}

/** Unparseable files younger than this may still be being written by their creator. */
const UNWRITTEN_GRACE_MS = 10_000;

function isStale(info: LockInfo | null, mtimeMs: number, staleMs: number | undefined): boolean {
  const age = Date.now() - mtimeMs;
  if (!info || typeof info.pid !== 'number' || !Number.isInteger(info.pid) || info.pid <= 0) return age > UNWRITTEN_GRACE_MS;
  if (staleMs !== undefined) {
    const at = typeof info.at === 'number' ? Math.min(info.at, mtimeMs) : mtimeMs;
    if (Date.now() - at > staleMs) return true;
  }
  if (info.pid === process.pid) return !(typeof info.token === 'string' && held.has(info.token));
  if (!pidAlive(info.pid)) return true;
  if (typeof info.start === 'string') {
    const now = processStartTime(info.pid);
    if (now !== null && now !== info.start) return true;
  }
  return false;
}

async function readInfo(path: string): Promise<LockInfo | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as LockInfo;
  } catch {
    return null;
  }
}

/** Takes the lock, or returns null when a live holder has it. */
export async function acquireLock(path: string, opts: { staleMs?: number } = {}): Promise<Lock | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const token = randomUUID();
    let handle;
    try {
      handle = await open(path, 'wx', 0o600);
    } catch (e) {
      if ((e as { code?: string }).code !== 'EEXIST') throw e;
      let before;
      try {
        before = await stat(path);
      } catch {
        continue; // vanished: retry the create
      }
      if (!isStale(await readInfo(path), before.mtimeMs, opts.staleMs)) return null;
      const aside = `${path}.stale-${process.pid}-${randomUUID()}`;
      try {
        await rename(path, aside);
      } catch {
        continue; // another contender moved it first
      }
      const moved = await stat(aside).catch(() => null);
      if (moved && moved.ino !== before.ino) {
        // We moved a lock created after our check (a live one): put it back unless the slot was refilled.
        await link(aside, path).catch(() => {});
      }
      await unlink(aside).catch(() => {});
      continue;
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, start: processStartTime(process.pid), at: Date.now(), token }));
    } finally {
      await handle.close();
    }
    held.add(token);
    const ours = (text: string | null) => {
      try {
        return text !== null && (JSON.parse(text) as LockInfo).token === token;
      } catch {
        return false;
      }
    };
    return {
      async release() {
        held.delete(token);
        if (ours(await readFile(path, 'utf8').catch(() => null))) await unlink(path).catch(() => {});
      },
      releaseSync() {
        held.delete(token);
        let text: string | null = null;
        try {
          text = readFileSync(path, 'utf8');
        } catch {
          return;
        }
        if (ours(text)) {
          try {
            unlinkSync(path);
          } catch {
            // already gone
          }
        }
      },
    };
  }
  return null;
}
