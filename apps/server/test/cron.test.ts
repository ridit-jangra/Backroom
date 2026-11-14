import { existsSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextDailyRun, runMaintenance, startDailySchedule, withMaintenanceLock } from '../src/cron';
import { tempDir } from './helpers';

const savedTz = process.env.TZ;
afterEach(() => {
  process.env.TZ = savedTz;
  vi.useRealTimers();
});

/** Runs `fn` with the process time zone set to `tz` (Node re-reads TZ when it changes). */
function inTz<T>(tz: string, fn: () => T): T {
  process.env.TZ = tz;
  return fn();
}

const iso = (d: Date) => d.toISOString();

describe('nextDailyRun (server local time)', () => {
  it('later today when 04:00 is still ahead, otherwise tomorrow', () => {
    inTz('UTC', () => {
      expect(iso(nextDailyRun(new Date('2026-11-14T03:59:59.999Z')))).toBe('2026-11-14T04:00:00.000Z');
      expect(iso(nextDailyRun(new Date('2026-11-14T04:00:00.000Z')))).toBe('2026-11-15T04:00:00.000Z');
      expect(iso(nextDailyRun(new Date('2026-11-14T23:00:00.000Z')))).toBe('2026-11-15T04:00:00.000Z');
      expect(iso(nextDailyRun(new Date('2026-12-31T05:00:00.000Z')))).toBe('2027-01-01T04:00:00.000Z');
    });
  });

  it('uses the local zone, not UTC', () => {
    inTz('Asia/Kolkata', () => {
      // 04:00 IST is 22:30 UTC the day before.
      expect(iso(nextDailyRun(new Date('2026-11-14T12:00:00.000Z')))).toBe('2026-11-14T22:30:00.000Z');
    });
  });

  it('DST spring forward (New York, 2026-03-08): the day is 23 h long, still 04:00 local', () => {
    inTz('America/New_York', () => {
      // 04:00 EST on Mar 7 = 09:00Z; 04:00 EDT on Mar 8 = 08:00Z.
      const after = new Date('2026-03-07T09:00:00.000Z');
      expect(iso(nextDailyRun(after))).toBe('2026-03-08T08:00:00.000Z');
    });
  });

  it('DST fall back (New York, 2026-11-01): the day is 25 h long, still 04:00 local', () => {
    inTz('America/New_York', () => {
      expect(iso(nextDailyRun(new Date('2026-10-31T08:00:00.000Z')))).toBe('2026-11-01T09:00:00.000Z');
    });
  });

  it('an hour that does not exist that day (02:30 on spring forward) runs once, at the next valid time', () => {
    inTz('America/New_York', () => {
      const run = nextDailyRun(new Date('2026-03-08T05:00:00.000Z'), 2, 30); // 00:00 EST
      expect(run.getTime()).toBeGreaterThan(new Date('2026-03-08T05:00:00.000Z').getTime());
      expect(iso(run)).toBe('2026-03-08T07:30:00.000Z'); // 03:30 EDT
      // The following run is the next day, not a second one the same day.
      expect(iso(nextDailyRun(run, 2, 30))).toBe('2026-03-09T06:30:00.000Z');
    });
  });

  it('an hour that happens twice (01:30 on fall back) runs only once', () => {
    inTz('America/New_York', () => {
      const first = nextDailyRun(new Date('2026-11-01T04:00:00.000Z'), 1, 30); // 00:00 EDT
      expect(iso(first)).toBe('2026-11-01T05:30:00.000Z'); // the first 01:30 (EDT)
      expect(iso(nextDailyRun(first, 1, 30))).toBe('2026-11-02T06:30:00.000Z');
    });
  });
});

describe('startDailySchedule', () => {
  it('fires at the next 04:00, re-arms for the day after, never overlaps, and stops', async () => {
    vi.useFakeTimers();
    process.env.TZ = 'UTC';
    vi.setSystemTime(new Date('2026-11-14T03:00:00.000Z'));
    let release!: () => void;
    const runs: string[] = [];
    const run = vi.fn(async () => {
      runs.push(new Date().toISOString());
      await new Promise<void>((r) => (release = r));
    });
    const s = startDailySchedule({ run });
    expect(iso(s.nextAt()!)).toBe('2026-11-14T04:00:00.000Z');
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(runs).toEqual(['2026-11-14T04:00:00.000Z']);
    // Still running a day later: the next tick is skipped rather than overlapping.
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(run).toHaveBeenCalledTimes(2);
    release();
    s.stop();
    await vi.advanceTimersByTimeAsync(3 * 86_400_000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(s.nextAt()).toBeNull();
  });

  it('a failing run is logged by code and the schedule carries on', async () => {
    vi.useFakeTimers();
    process.env.TZ = 'UTC';
    vi.setSystemTime(new Date('2026-11-14T03:59:00.000Z'));
    const log = vi.fn();
    const run = vi.fn(async () => {
      throw new Error('boom owner@example.com');
    });
    const s = startDailySchedule({ run, log });
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith('error', 'maintenance_failed', expect.anything());
    expect(JSON.stringify(log.mock.calls)).not.toContain('owner@example.com');
    s.stop();
  });
});

describe('withMaintenanceLock', () => {
  it('runs the job holding a lock file and removes it afterwards', async () => {
    const lock = join(tempDir(), 'maintenance.lock');
    let held = false;
    expect(await withMaintenanceLock(lock, async () => void (held = existsSync(lock)))).toBe('ran');
    expect(held).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  it('a second, overlapping run (another process or this one) is skipped', async () => {
    const lock = join(tempDir(), 'maintenance.lock');
    let release: (() => void) | undefined;
    const first = withMaintenanceLock(lock, () => new Promise<void>((r) => (release = r)));
    await vi.waitFor(() => expect(release).toBeDefined());
    const job = vi.fn(async () => {});
    expect(await withMaintenanceLock(lock, job)).toBe('locked');
    expect(job).not.toHaveBeenCalled();
    release!();
    expect(await first).toBe('ran');
  });

  it('a stale lock (dead pid or older than the limit) is taken over', async () => {
    const dir = tempDir();
    const lock = join(dir, 'maintenance.lock');
    writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
    expect(await withMaintenanceLock(lock, async () => {})).toBe('ran');
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: 0 }));
    const old = new Date(Date.now() - 7 * 3_600_000);
    utimesSync(lock, old, old);
    expect(await withMaintenanceLock(lock, async () => {})).toBe('ran');
  });

  it('the lock is released when the job throws', async () => {
    const lock = join(tempDir(), 'maintenance.lock');
    await expect(withMaintenanceLock(lock, async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(existsSync(lock)).toBe(false);
  });
});

describe('runMaintenance', () => {
  it("calls the worker's scheduled handler and waits for all of its waitUntil work", async () => {
    const done: string[] = [];
    const scheduled = vi.fn((controller: ScheduledController, _env: unknown, ctx: ExecutionContext) => {
      expect(controller.cron).toBe('0 4 * * *');
      expect(controller.scheduledTime).toBe(1234);
      ctx.waitUntil(new Promise<void>((r) => setTimeout(() => (done.push('a'), r()), 20)));
      ctx.waitUntil(Promise.reject(new Error('handled inside the worker')).catch(() => done.push('b')));
    });
    await runMaintenance(scheduled, { env: true }, 1234);
    expect(scheduled).toHaveBeenCalledWith(expect.anything(), { env: true }, expect.anything());
    expect(done.sort()).toEqual(['a', 'b']);
  });
});
