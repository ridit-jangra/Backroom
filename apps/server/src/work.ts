/**
 * The ExecutionContext handed to the app: `waitUntil` work (deferred sign-in email, upload commits, channel repair)
 * is tracked so graceful shutdown can wait for it. A rejection is logged by code only.
 */
import { type Log, errorFields } from './log';

export interface WorkTracker {
  ctx: ExecutionContext;
  /** Resolves once no tracked work is pending, including work registered while waiting. */
  drain(): Promise<void>;
  size(): number;
}

export function createWorkTracker(log: Log): WorkTracker {
  const pending = new Set<Promise<void>>();
  const waitUntil = (promise: Promise<unknown>): void => {
    const p: Promise<void> = Promise.resolve(promise)
      .then(
        () => {},
        (e: unknown) => log('error', 'wait_until_failed', errorFields(e)),
      )
      .finally(() => pending.delete(p));
    pending.add(p);
  };
  const ctx = {
    waitUntil,
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
  return {
    ctx,
    async drain() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
    size: () => pending.size,
  };
}
