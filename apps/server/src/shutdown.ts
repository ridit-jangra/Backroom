/**
 * Graceful shutdown on SIGTERM/SIGINT. Order:
 * 1. stop the maintenance timer and stop accepting connections;
 * 2. close every hub WebSocket with 1001 and give the close frames a moment to go out, then terminate what is
 *    left (bridge), cancel hub alarms, and wait for hub handlers;
 * 3. wait for `waitUntil` work and in-flight requests, up to `timeoutMs`, then force connections closed;
 * 4. checkpoint the WAL and close the database; exit 0 (1 if the database could not be closed).
 * A second signal exits at once with 1.
 */
import { type Log, errorFields } from './log';

export interface ShutdownSteps {
  stopScheduler(): void;
  stopAccepting(): void;
  closeHubSockets(): void;
  waitForSockets(ms: number): Promise<void>;
  closeBridge(): void;
  disposeHubs(): void;
  drainHubs(): Promise<void>;
  drainWork(): Promise<void>;
  drainRequests(): Promise<void>;
  forceCloseConnections(): void;
  closeDb(): void;
}

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
export const DEFAULT_WS_GRACE_MS = 1_000;

export function createShutdown(
  steps: ShutdownSteps,
  opts: { exit: (code: number) => void; log: Log; timeoutMs?: number; wsGraceMs?: number },
): { onSignal(signal: string, exitCode?: number): void; done: Promise<void> } {
  const { log, exit } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const wsGraceMs = opts.wsGraceMs ?? DEFAULT_WS_GRACE_MS;
  let started = false;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));

  const step = async (name: keyof ShutdownSteps, fn: () => unknown): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      log('error', 'shutdown_step_failed', { step: name, ...errorFields(e) });
    }
  };

  async function run(signal: string, requestedCode: number): Promise<void> {
    const t0 = Date.now();
    log('info', 'shutdown_started', { signal });
    await step('stopScheduler', () => steps.stopScheduler());
    await step('stopAccepting', () => steps.stopAccepting());
    await step('closeHubSockets', () => steps.closeHubSockets());
    await step('waitForSockets', () => steps.waitForSockets(wsGraceMs));
    await step('closeBridge', () => steps.closeBridge());
    await step('disposeHubs', () => steps.disposeHubs());

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timeout'>((r) => {
      timer = setTimeout(() => r('timeout'), timeoutMs);
    });
    const drained = Promise.all([
      step('drainHubs', () => steps.drainHubs()),
      step('drainWork', () => steps.drainWork()),
      step('drainRequests', () => steps.drainRequests()),
    ]).then(() => 'drained' as const);
    const outcome = await Promise.race([drained, timedOut]);
    clearTimeout(timer);
    if (outcome === 'timeout') {
      log('warn', 'shutdown_timeout', { timeoutMs });
      await step('forceCloseConnections', () => steps.forceCloseConnections());
    }

    let code = requestedCode;
    try {
      steps.closeDb();
    } catch (e) {
      log('error', 'shutdown_db_close_failed', errorFields(e));
      code = 1;
    }
    log('info', 'shutdown_complete', { ms: Date.now() - t0, exitCode: code });
    resolveDone();
    exit(code);
  }

  return {
    onSignal(signal, exitCode = 0) {
      if (started) {
        log('warn', 'shutdown_forced', { signal });
        exit(1);
        return;
      }
      started = true;
      void run(signal, exitCode);
    },
    done,
  };
}
