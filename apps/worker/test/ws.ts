import { createExecutionContext, env } from 'cloudflare:test';
import type { Hono } from 'hono';
import { parseHubFrame, type ClientFrame, type HubFrame } from '@backroom/protocol';
import type { AppEnv } from '../src/app';
import type { WorkspaceHub } from '../src/hub/WorkspaceHub';

export const CLUBHACK_WS = '01JCLUBHACK0000000000000WS';

export type TestSocket = {
  /** Every frame received, in order (consumed or not). */
  frames: HubFrame[];
  send(f: ClientFrame | string): void;
  /** Returns and removes the oldest unconsumed frame of type `t`, waiting for one if none is queued. */
  next<T extends HubFrame['t']>(t: T, timeoutMs?: number): Promise<Extract<HubFrame, { t: T }>>;
  /** Fails if an unconsumed frame of type `t` is queued or arrives within `ms`. */
  none(t: HubFrame['t'], ms?: number): Promise<void>;
  closed(): Promise<{ code: number }>;
  close(): void;
};

const open: TestSocket[] = [];

export async function upgrade(app: Hono<AppEnv>, headers: Record<string, string>, slug = 'clubhack'): Promise<Response> {
  const ctx = createExecutionContext();
  return app.request(`/ws?workspace=${encodeURIComponent(slug)}`, { method: 'GET', headers }, env, ctx);
}

function wrap(ws: WebSocket): TestSocket {
  const frames: HubFrame[] = [];
  const queue: HubFrame[] = [];
  const waiters: { t: HubFrame['t']; resolve: (f: HubFrame) => void }[] = [];
  let closeInfo: { code: number } | null = null;
  const closeWaiters: ((c: { code: number }) => void)[] = [];

  ws.addEventListener('message', (ev) => {
    if (typeof ev.data !== 'string') return;
    const f = parseHubFrame(ev.data);
    if (!f) throw new Error(`unparseable hub frame: ${ev.data.slice(0, 200)}`);
    frames.push(f);
    const i = waiters.findIndex((w) => w.t === f.t);
    if (i >= 0) waiters.splice(i, 1)[0]!.resolve(f);
    else queue.push(f);
  });
  ws.addEventListener('close', (ev) => {
    closeInfo = { code: ev.code };
    for (const w of closeWaiters.splice(0)) w(closeInfo);
  });

  return {
    frames,
    send(f) {
      ws.send(typeof f === 'string' ? f : JSON.stringify(f));
    },
    next(t, timeoutMs = 2_000) {
      const i = queue.findIndex((f) => f.t === t);
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0] as never);
      return new Promise((resolve, reject) => {
        const w = { t, resolve: resolve as (f: HubFrame) => void };
        waiters.push(w);
        setTimeout(() => {
          const j = waiters.indexOf(w);
          if (j >= 0) {
            waiters.splice(j, 1);
            reject(new Error(`timed out waiting for '${t}' frame`));
          }
        }, timeoutMs);
      });
    },
    async none(t, ms = 150) {
      await new Promise((r) => setTimeout(r, ms));
      const f = queue.find((x) => x.t === t);
      if (f) throw new Error(`unexpected '${t}' frame: ${JSON.stringify(f)}`);
    },
    closed() {
      if (closeInfo) return Promise.resolve(closeInfo);
      return new Promise((r) => closeWaiters.push(r));
    },
    close() {
      try {
        ws.close(1000, 'bye');
      } catch {
        // already closed
      }
    },
  };
}

export async function connect(app: Hono<AppEnv>, cookie: string): Promise<TestSocket> {
  const res = await upgrade(app, { Cookie: cookie, Origin: 'https://app.test', Upgrade: 'websocket' });
  if (res.status !== 101 || !res.webSocket) throw new Error(`upgrade failed: ${res.status} ${await res.text()}`);
  res.webSocket.accept();
  const s = wrap(res.webSocket);
  open.push(s);
  return s;
}

/** Wraps an already-upgraded 101 response (e.g. a Bearer upgrade) so `closeAll` covers it. */
export function adopt(res: Response): TestSocket {
  res.webSocket!.accept();
  const s = wrap(res.webSocket!);
  open.push(s);
  return s;
}

/** Close every socket opened through this module (call from `afterEach`). */
export function closeAll(): void {
  for (const s of open.splice(0)) s.close();
}

export function hubStub(): DurableObjectStub<WorkspaceHub> {
  return env.HUB.getByName(CLUBHACK_WS);
}
