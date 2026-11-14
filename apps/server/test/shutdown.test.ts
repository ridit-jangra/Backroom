import { describe, expect, it, vi } from 'vitest';
import { type ShutdownSteps, createShutdown } from '../src/shutdown';

function fakes(overrides: Partial<ShutdownSteps> = {}) {
  const order: string[] = [];
  const step =
    (name: string) =>
    (..._args: unknown[]) => {
      order.push(name);
    };
  const asyncStep = (name: string) => async () => {
    order.push(name);
  };
  const steps: ShutdownSteps = {
    stopScheduler: step('stopScheduler'),
    stopAccepting: step('stopAccepting'),
    closeHubSockets: step('closeHubSockets'),
    waitForSockets: async (ms: number) => {
      order.push(`waitForSockets(${ms})`);
    },
    closeBridge: step('closeBridge'),
    disposeHubs: step('disposeHubs'),
    drainHubs: asyncStep('drainHubs'),
    drainWork: asyncStep('drainWork'),
    drainRequests: asyncStep('drainRequests'),
    forceCloseConnections: step('forceCloseConnections'),
    closeDb: step('closeDb'),
    ...overrides,
  };
  const exit = vi.fn();
  const log = vi.fn();
  return { order, steps, exit, log };
}

describe('graceful shutdown', () => {
  it('runs the steps in order and exits 0', async () => {
    const f = fakes();
    const s = createShutdown(f.steps, { exit: f.exit, log: f.log, timeoutMs: 1000, wsGraceMs: 250 });
    s.onSignal('SIGTERM');
    await s.done;
    expect(f.order).toEqual([
      'stopScheduler',
      'stopAccepting',
      'closeHubSockets',
      'waitForSockets(250)',
      'closeBridge',
      'disposeHubs',
      'drainHubs',
      'drainWork',
      'drainRequests',
      'closeDb',
    ]);
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(f.log).toHaveBeenCalledWith('info', 'shutdown_started', { signal: 'SIGTERM' });
    expect(f.log).toHaveBeenCalledWith('info', 'shutdown_complete', expect.anything());
  });

  it('the database closes only after hub handlers, waitUntil work and requests have drained', async () => {
    const releases: Record<string, () => void> = {};
    const pending = (name: string) => () =>
      new Promise<void>((r) => {
        releases[name] = () => {
          f.order.push(`${name} done`);
          r();
        };
      });
    const f = fakes({ drainHubs: pending('drainHubs'), drainWork: pending('drainWork'), drainRequests: pending('drainRequests') });
    const s = createShutdown(f.steps, { exit: f.exit, log: f.log, timeoutMs: 5000 });
    s.onSignal('SIGINT');
    await vi.waitFor(() => expect(Object.keys(releases)).toHaveLength(3));
    releases.drainWork!();
    releases.drainRequests!();
    await new Promise((r) => setTimeout(r, 20));
    expect(f.order).not.toContain('closeDb');
    releases.drainHubs!();
    await s.done;
    expect(f.order.indexOf('closeDb')).toBeGreaterThan(f.order.indexOf('drainHubs done'));
    expect(f.exit).toHaveBeenCalledWith(0);
  });

  it('after the time limit: forces connections closed, then still closes the database and exits 0', async () => {
    const f = fakes({ drainRequests: () => new Promise<void>(() => {}) });
    const s = createShutdown(f.steps, { exit: f.exit, log: f.log, timeoutMs: 50 });
    s.onSignal('SIGTERM');
    await s.done;
    expect(f.order.slice(-2)).toEqual(['forceCloseConnections', 'closeDb']);
    expect(f.log).toHaveBeenCalledWith('warn', 'shutdown_timeout', expect.anything());
    expect(f.exit).toHaveBeenCalledWith(0);
  });

  it('a second signal forces an immediate exit', async () => {
    const f = fakes({ drainWork: () => new Promise<void>(() => {}) });
    const s = createShutdown(f.steps, { exit: f.exit, log: f.log, timeoutMs: 60_000 });
    s.onSignal('SIGTERM');
    await vi.waitFor(() => expect(f.order).toContain('drainHubs'));
    s.onSignal('SIGTERM');
    expect(f.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(f.log).toHaveBeenCalledWith('warn', 'shutdown_forced', { signal: 'SIGTERM' });
  });

  it('a failing step is logged by code and does not stop the rest', async () => {
    const f = fakes({
      closeBridge: () => {
        throw new Error('secret detail');
      },
    });
    const s = createShutdown(f.steps, { exit: f.exit, log: f.log, timeoutMs: 1000 });
    s.onSignal('SIGTERM');
    await s.done;
    expect(f.order).toContain('closeDb');
    expect(f.log).toHaveBeenCalledWith('error', 'shutdown_step_failed', expect.objectContaining({ step: 'closeBridge' }));
    expect(JSON.stringify(f.log.mock.calls)).not.toContain('secret detail');
    expect(f.exit).toHaveBeenCalledWith(0);
  });

  it('a database that fails to close exits 1', async () => {
    const f = fakes({
      closeDb: () => {
        throw new Error('disk');
      },
    });
    const s = createShutdown(f.steps, { exit: f.exit, log: f.log, timeoutMs: 1000 });
    s.onSignal('SIGTERM');
    await s.done;
    expect(f.exit).toHaveBeenCalledWith(1);
  });

  it('an exit code can be requested (fatal error path)', async () => {
    const f = fakes();
    const s = createShutdown(f.steps, { exit: f.exit, log: f.log, timeoutMs: 1000 });
    s.onSignal('uncaughtException', 1);
    await s.done;
    expect(f.exit).toHaveBeenCalledWith(1);
  });
});
