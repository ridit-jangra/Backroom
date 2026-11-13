import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientFrame, FileInfo } from '@backroom/protocol';
import { Outbox, type PendingSend } from '../src/realtime/outbox';

const CH = '01JCHANNEL0000000000000000';
let t = 0;
let sent: ClientFrame[];
let last: PendingSend[];
let connected: boolean;

function make() {
  return new Outbox({
    send: (f) => {
      if (!connected) return false;
      sent.push(f);
      return true;
    },
    onChange: (p) => (last = p),
    now: () => t,
  });
}
const msg = { channelId: CH, parentId: null, body: 'hi', alsoInChannel: false };

beforeEach(() => {
  t = 1000;
  sent = [];
  last = [];
  connected = true;
});

describe('Outbox', () => {
  it('sends on enqueue with a uuid clientId', () => {
    const o = make();
    const id = o.enqueue(msg);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ t: 'send', clientId: id, channelId: CH, body: 'hi' });
    expect(last[0]).toMatchObject({ status: 'sending', attempts: 1 });
  });

  it('resends with same clientId after 10 s', () => {
    const o = make();
    const id = o.enqueue(msg);
    t += 9_999;
    o.tick();
    expect(sent).toHaveLength(1);
    t += 1;
    o.tick();
    expect(sent).toHaveLength(2);
    expect((sent[1] as { clientId: string }).clientId).toBe(id);
  });

  it('ack removes the entry', () => {
    const o = make();
    const id = o.enqueue(msg);
    o.ack(id);
    expect(last).toEqual([]);
    t += 60_000;
    o.tick();
    expect(sent).toHaveLength(1);
  });

  it('three unacked attempts mark failed', () => {
    const o = make();
    o.enqueue(msg);
    for (let i = 0; i < 3; i++) {
      t += 10_000;
      o.tick();
    }
    expect(sent).toHaveLength(3);
    expect(last[0]).toMatchObject({ status: 'failed', attempts: 3 });
    t += 10_000;
    o.tick();
    expect(sent).toHaveLength(3);
  });

  it('nack too_long marks failed with error; retry resends same clientId', () => {
    const o = make();
    const id = o.enqueue({ ...msg, parentId: 'P', alsoInChannel: true });
    o.nack(id, 'too_long');
    expect(last[0]).toMatchObject({ status: 'failed', error: 'too_long' });
    o.retry(id);
    expect(last[0]!.status).toBe('sending');
    expect(last[0]!.error).toBeUndefined();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ clientId: id, parentId: 'P', alsoInChannel: true });
  });

  it('nack rate_limited is a terminal failure carrying the code (no automatic resend)', () => {
    const o = make();
    const id = o.enqueue(msg);
    o.nack(id, 'rate_limited');
    expect(last[0]).toMatchObject({ status: 'failed', error: 'rate_limited' });
    o.flush();
    expect(sent).toHaveLength(1);
  });

  it('flush resends pending after reconnect', () => {
    connected = false;
    const o = make();
    const id = o.enqueue(msg);
    expect(sent).toHaveLength(0);
    connected = true;
    o.flush();
    expect(sent).toHaveLength(1);
    expect((sent[0] as { clientId: string }).clientId).toBe(id);
  });

  it('flapping reconnect flushes do not fail the message; ticks do', () => {
    const o = make();
    o.enqueue(msg);
    for (let i = 0; i < 3; i++) {
      t += 1000;
      o.flush();
    }
    expect(last[0]).toMatchObject({ status: 'sending', attempts: 1 });
    expect(sent).toHaveLength(4);
    for (let i = 0; i < 3; i++) {
      t += 10_000;
      o.tick();
    }
    expect(last[0]?.status).toBe('failed');
  });

  it('offline tick leaves attempts at 0', () => {
    connected = false;
    const o = make();
    o.enqueue(msg);
    t += 10_000;
    o.tick();
    expect(last[0]).toMatchObject({ status: 'sending', attempts: 0 });
  });

  it('ack/nack of unknown id are no-ops', () => {
    const o = make();
    const id = o.enqueue(msg);
    o.ack('nope');
    o.nack('nope', 'failed');
    expect(last).toHaveLength(1);
    expect(last[0]?.clientId).toBe(id);
    expect(last[0]?.status).toBe('sending');
  });

  it('discard removes the entry', () => {
    const o = make();
    const id = o.enqueue(msg);
    o.discard(id);
    expect(last).toEqual([]);
  });

  const F: FileInfo = { id: 'f'.repeat(26), name: 'a.png', mime: 'image/png', size: 1, width: null, height: null, hasThumb: false };

  it('files become fileIds; no files means no fileIds field', () => {
    const o = make();
    o.enqueue({ ...msg, files: [F] });
    expect((sent[0] as { fileIds?: string[] }).fileIds).toEqual([F.id]);
    o.enqueue(msg);
    expect('fileIds' in sent[1]!).toBe(false);
    o.enqueue({ ...msg, body: '', files: [F] });
    expect(sent[2]).toMatchObject({ body: '', fileIds: [F.id] });
  });

  it('a nack (e.g. invalid after a failed attach) is terminal: no automatic resend', () => {
    const o = make();
    const id = o.enqueue({ ...msg, files: [F] });
    o.nack(id, 'invalid');
    t += 60_000;
    o.tick();
    o.flush();
    expect(sent).toHaveLength(1);
    expect(last[0]).toMatchObject({ status: 'failed', error: 'invalid' });
  });
});
