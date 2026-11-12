import { RESEND_AFTER_MS, type ClientFrame, type FileInfo, type NackCode } from '@backroom/protocol';

export type PendingSend = {
  clientId: string;
  channelId: string;
  parentId: string | null;
  body: string;
  alsoInChannel: boolean;
  files: FileInfo[];
  status: 'sending' | 'failed';
  error?: NackCode;
  attempts: number;
  lastSentAt: number;
};

const MAX_ATTEMPTS = 3;

export interface OutboxOptions {
  send: (f: ClientFrame) => boolean;
  onChange: (pending: PendingSend[]) => void;
  now?: () => number;
}

export class Outbox {
  private items = new Map<string, PendingSend>();
  private readonly now: () => number;

  constructor(private readonly opts: OutboxOptions) {
    this.now = opts.now ?? Date.now;
  }

  enqueue(p: { channelId: string; parentId: string | null; body: string; alsoInChannel: boolean; files?: FileInfo[] }): string {
    const clientId = crypto.randomUUID();
    const item: PendingSend = { ...p, files: p.files ?? [], clientId, status: 'sending', attempts: 0, lastSentAt: 0 };
    this.items.set(clientId, item);
    this.transmit(item);
    this.emit();
    return clientId;
  }

  ack(clientId: string): void {
    if (this.items.delete(clientId)) this.emit();
  }

  nack(clientId: string, code: NackCode): void {
    const it = this.items.get(clientId);
    if (!it) return;
    it.status = 'failed';
    it.error = code;
    this.emit();
  }

  retry(clientId: string): void {
    const it = this.items.get(clientId);
    if (!it) return;
    it.status = 'sending';
    delete it.error;
    it.attempts = 0;
    this.transmit(it);
    this.emit();
  }

  discard(clientId: string): void {
    if (this.items.delete(clientId)) this.emit();
  }

  /** Resend every 'sending' entry after a (re)connect, without counting an attempt. */
  flush(): void {
    let changed = false;
    for (const it of this.items.values()) {
      if (it.status !== 'sending') continue;
      this.transmit(it, false);
      changed = true;
    }
    if (changed) this.emit();
  }

  /** Called every second. */
  tick(): void {
    const t = this.now();
    let changed = false;
    for (const it of this.items.values()) {
      if (it.status !== 'sending' || t - it.lastSentAt < RESEND_AFTER_MS) continue;
      if (it.attempts >= MAX_ATTEMPTS) it.status = 'failed';
      else this.transmit(it);
      changed = true;
    }
    if (changed) this.emit();
  }

  private transmit(it: PendingSend, countAttempt = true): void {
    const frame: ClientFrame = {
      t: 'send',
      clientId: it.clientId,
      channelId: it.channelId,
      body: it.body,
      ...(it.parentId !== null ? { parentId: it.parentId } : {}),
      ...(it.alsoInChannel ? { alsoInChannel: true } : {}),
      ...(it.files.length > 0 ? { fileIds: it.files.map((f) => f.id) } : {}),
    };
    // Count only real transmissions so an offline period does not burn attempts.
    const sentOk = this.opts.send(frame);
    if (sentOk && countAttempt) it.attempts += 1;
    if (sentOk || countAttempt) it.lastSentAt = this.now();
  }

  private emit(): void {
    this.opts.onChange([...this.items.values()].map((i) => ({ ...i })));
  }
}
