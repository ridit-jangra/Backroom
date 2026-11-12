import { PING_FRAME, parseHubFrame, type ClientFrame, type HubFrame } from '@backroom/protocol';

export type SocketState = 'connecting' | 'open' | 'reconnecting' | 'closed';

const PING_EVERY_MS = 30_000;
const PONG_WITHIN_MS = 10_000;
const AUTH_LOST_CODE = 4001;

export function backoffDelay(attempt: number, random: number): number {
  const base = Math.min(30_000, 1_000 * 2 ** attempt);
  return base / 2 + (random * base) / 2;
}

export function wsUrl(slug: string): string {
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?workspace=${encodeURIComponent(slug)}`;
}

export interface HubSocketOptions {
  url: string;
  onFrame: (f: HubFrame) => void;
  onState: (s: SocketState) => void;
  onOpen: () => void;
  onAuthLost: () => void;
  probeAuth: () => Promise<boolean>;
  WebSocketImpl?: typeof WebSocket;
  random?: () => number;
}

export class HubSocket {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private stopped = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: HubSocketOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.connect('connecting');
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
    this.opts.onState('closed');
  }

  send(f: ClientFrame): boolean {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify(f));
      return true;
    } catch {
      return false;
    }
  }

  private connect(state: SocketState): void {
    this.opts.onState(state);
    const Impl = this.opts.WebSocketImpl ?? WebSocket;
    const ws = new Impl(this.opts.url);
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.opts.onState('open');
      this.startPing(ws);
      this.opts.onOpen();
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws || typeof ev.data !== 'string') return;
      const frame = parseHubFrame(ev.data);
      if (!frame) return;
      if (frame.t === 'pong') {
        this.clearPong();
        return;
      }
      this.opts.onFrame(frame);
    };
    // Browsers fire `error` then `close`; reconnect is scheduled only from close.
    ws.onerror = () => {};
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearTimers();
      if (this.stopped) return;
      if (ev.code === AUTH_LOST_CODE) {
        this.stopped = true;
        this.opts.onState('closed');
        this.opts.onAuthLost();
        return;
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    const n = this.attempt++;
    this.opts.onState('reconnecting');
    const delay = backoffDelay(n, (this.opts.random ?? Math.random)());
    if (this.attempt >= 2) {
      void this.opts
        .probeAuth()
        .then((ok) => {
          if (!ok && !this.stopped) {
            this.stopped = true;
            this.clearTimers();
            this.opts.onState('closed');
            this.opts.onAuthLost();
          }
        })
        .catch(() => {});
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.connect('reconnecting');
    }, delay);
  }

  private startPing(ws: WebSocket): void {
    this.clearTimers();
    this.pingTimer = setInterval(() => {
      if (this.ws !== ws) return;
      try {
        ws.send(PING_FRAME);
      } catch {
        /* close handler will follow */
      }
      this.clearPong();
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null;
        if (this.ws === ws) ws.close();
      }, PONG_WITHIN_MS);
    }, PING_EVERY_MS);
  }

  private clearPong(): void {
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pongTimer = null;
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.clearPong();
  }
}
