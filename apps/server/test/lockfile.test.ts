import { existsSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireLock, processStartTime } from '../src/lockfile';
import { tempDir } from './helpers';

const DEAD_PID = 2 ** 22 + 12345; // above Linux's pid_max

describe('acquireLock', () => {
  it('creates the lock with this pid, refuses a second holder, and release removes it', async () => {
    const dir = tempDir();
    const path = join(dir, 'server.lock');
    const lock = await acquireLock(path);
    expect(lock).not.toBeNull();
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ pid: process.pid });
    const second = await acquireLock(path);
    expect(second).toBeNull();
    await lock!.release();
    expect(existsSync(path)).toBe(false);
    const again = await acquireLock(path);
    expect(again).not.toBeNull();
    again!.releaseSync();
    expect(existsSync(path)).toBe(false);
  });

  it('a lock whose process is gone (crash) is taken over, leaving no stray files', async () => {
    const dir = tempDir();
    const path = join(dir, 'server.lock');
    writeFileSync(path, JSON.stringify({ pid: DEAD_PID, start: null, at: Date.now(), token: 'old' }));
    const lock = await acquireLock(path);
    expect(lock).not.toBeNull();
    expect(JSON.parse(readFileSync(path, 'utf8')).pid).toBe(process.pid);
    expect(readdirSync(dir)).toEqual(['server.lock']);
    await lock!.release();
  });

  it('a lock naming this very pid is stale (pid reuse after a container restart)', async () => {
    const path = join(tempDir(), 'server.lock');
    writeFileSync(path, JSON.stringify({ pid: process.pid, start: 'x', at: Date.now(), token: 'old' }));
    const lock = await acquireLock(path);
    expect(lock).not.toBeNull();
    await lock!.release();
  });

  it('a live pid whose start time differs from the recorded one is a reused pid: stale', async () => {
    const path = join(tempDir(), 'server.lock');
    // pid 1 is always alive; its recorded start time does not match.
    writeFileSync(path, JSON.stringify({ pid: 1, start: 'not-the-real-start', at: Date.now(), token: 'old' }));
    const lock = await acquireLock(path);
    if (processStartTime(1) === null) expect(lock).toBeNull(); // no /proc: cannot tell, so stays locked
    else expect(lock).not.toBeNull();
    await lock?.release();
  });

  it('a live holder with a matching start time keeps the lock', async () => {
    const path = join(tempDir(), 'server.lock');
    writeFileSync(path, JSON.stringify({ pid: 1, start: processStartTime(1), at: Date.now(), token: 'old' }));
    expect(await acquireLock(path)).toBeNull();
  });

  it('staleMs: an old lock is stale even if its pid looks alive', async () => {
    const path = join(tempDir(), 'm.lock');
    writeFileSync(path, JSON.stringify({ pid: 1, start: processStartTime(1), at: 0, token: 'old' }));
    const old = new Date(Date.now() - 7 * 3_600_000);
    utimesSync(path, old, old);
    expect(await acquireLock(path)).toBeNull();
    const lock = await acquireLock(path, { staleMs: 6 * 3_600_000 });
    expect(lock).not.toBeNull();
    await lock!.release();
  });

  it('release never removes a lock someone else took over meanwhile', async () => {
    const path = join(tempDir(), 'server.lock');
    const lock = await acquireLock(path);
    writeFileSync(path, JSON.stringify({ pid: 1, start: processStartTime(1), at: Date.now(), token: 'theirs' }));
    await lock!.release();
    expect(existsSync(path)).toBe(true);
  });

  it('concurrent takeovers of one stale lock: exactly one wins', async () => {
    const dir = tempDir();
    const path = join(dir, 'server.lock');
    writeFileSync(path, JSON.stringify({ pid: DEAD_PID, start: null, at: Date.now(), token: 'old' }));
    const results = await Promise.all(Array.from({ length: 8 }, () => acquireLock(path)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(readdirSync(dir)).toEqual(['server.lock']);
  });
});
