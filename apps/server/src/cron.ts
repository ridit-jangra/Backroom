/**
 * Daily maintenance (the Workers cron `0 4 * * *`): the worker's own `scheduled` handler, run at 04:00 server local
 * time by an in-process timer, or once with `--maintenance`. A lock file in the data directory keeps two runs
 * (this process, a second server, or a `--maintenance` run) from overlapping.
 */
import { acquireLock } from './lockfile';
import { type Log, errorFields } from './log';

export const MAINTENANCE_HOUR = 4;
export const MAINTENANCE_CRON = '0 4 * * *';
/** A lock older than this is from a run that died without cleaning up. */
export const LOCK_STALE_MS = 6 * 3_600_000;

/**
 * The first local `hour:minute` strictly after `now`. Built from calendar fields, so a DST change makes that day
 * 23 or 25 hours long instead of shifting the time. A time skipped by spring-forward resolves to the next valid
 * time that day (JS Date normalisation); a time that happens twice resolves to its first occurrence, so it runs once.
 */
export function nextDailyRun(now: Date, hour = MAINTENANCE_HOUR, minute = 0): Date {
  for (let day = 0; day <= 2; day++) {
    const t = new Date(now.getFullYear(), now.getMonth(), now.getDate() + day, hour, minute, 0, 0);
    if (t.getTime() > now.getTime()) return t;
  }
  // Unreachable in practice (each calendar day has its own hour:minute); fall back to 24 h from now.
  return new Date(now.getTime() + 86_400_000);
}

const noop: Log = () => {};

export interface DailySchedule {
  stop(): void;
  /** When the next run is due, or null once stopped. */
  nextAt(): Date | null;
  /** The run in progress (settles when it ends, never rejects), or null. Shutdown waits on it. */
  running(): Promise<void> | null;
}

/** Runs `run` every day at the local hour; a run still going when the next is due makes that one a skip. */
export function startDailySchedule(opts: { run: () => Promise<unknown>; hour?: number; log?: Log }): DailySchedule {
  const log = opts.log ?? noop;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let next: Date | null = null;
  let current: Promise<void> | null = null;
  let stopped = false;

  const arm = () => {
    if (stopped) return;
    next = nextDailyRun(new Date(), opts.hour ?? MAINTENANCE_HOUR);
    // setTimeout caps at 2^31-1 ms; the delay is at most ~25 h, and a late timer just recomputes.
    timer = setTimeout(fire, Math.max(0, next.getTime() - Date.now()));
    timer.unref?.();
  };

  const fire = () => {
    timer = null;
    if (next && Date.now() < next.getTime()) return arm(); // woke early (clock change): wait for the real time
    if (current) log('warn', 'maintenance_skipped', { reason: 'still_running' });
    else {
      const run: Promise<void> = Promise.resolve()
        .then(opts.run)
        .then(
          () => {},
          (e: unknown) => log('error', 'maintenance_failed', errorFields(e)),
        )
        .finally(() => {
          if (current === run) current = null;
        });
      current = run;
    }
    arm();
  };

  arm();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      next = null;
    },
    nextAt: () => next,
    running: () => current,
  };
}

/** Runs `job` holding an exclusive lock file; returns 'locked' (without running it) when another run holds it. */
export async function withMaintenanceLock(path: string, job: () => Promise<unknown>, log: Log = noop): Promise<'ran' | 'locked'> {
  const lock = await acquireLock(path, { staleMs: LOCK_STALE_MS });
  if (!lock) {
    log('info', 'maintenance_skipped', { reason: 'locked' });
    return 'locked';
  }
  // Released even if the process exits mid-run (forced shutdown).
  const onExit = () => lock.releaseSync();
  process.once('exit', onExit);
  try {
    await job();
  } finally {
    process.off('exit', onExit);
    await lock.release();
  }
  return 'ran';
}

type Scheduled = (controller: ScheduledController, env: never, ctx: ExecutionContext) => unknown;

/**
 * Calls the worker's `scheduled` handler the way the Workers cron did and waits for all of its `waitUntil` work.
 * The handler catches and logs its own job failures.
 */
export async function runMaintenance(scheduled: Scheduled, env: unknown, scheduledTime = Date.now()): Promise<void> {
  const work: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void work.push(Promise.resolve(p).catch(() => {})),
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
  const controller = { scheduledTime, cron: MAINTENANCE_CRON, noRetry() {} } as ScheduledController;
  await scheduled(controller, env as never, ctx);
  while (work.length > 0) await Promise.all(work.splice(0));
}
