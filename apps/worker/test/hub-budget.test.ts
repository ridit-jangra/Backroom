import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { sendMessage } from '../src/messaging/store';
import { getAtt } from '../src/hub/attachment';
import { FRAME_BUDGET_BURST, FRAME_BUDGET_PER_SEC, TYPING_FRAME_COST, takeFrameBudget } from '../src/hub/budget';
import { GENERAL, captureMailer, resetDb, seedUsers, testDeps } from './helpers';
import { closeAll, connect, hubStub, type TestSocket } from './ws';

const T = 1_800_000_000_000;

beforeEach(resetDb);
afterEach(async () => {
  await closeAll();
  await runInDurableObject(hubStub(), (hub) => {
    hub.now = () => Date.now();
  });
  await runDurableObjectAlarm(hubStub());
});

async function setClock(t: number) {
  await runInDurableObject(hubStub(), (hub) => {
    hub.now = () => t;
  });
}

async function setup() {
  const { mailer, sent } = captureMailer();
  const app = createApp(testDeps({ mailer }));
  const [owner, alice, bob] = await seedUsers(app, sent, ['owner@test.dev', 'alice@test.dev', 'bob@test.dev']);
  return { app, owner: owner!, alice: alice!, bob: bob! };
}

async function say(userId: string): Promise<string> {
  const r = await sendMessage(env.DB, {
    clientId: crypto.randomUUID(), channelId: GENERAL, userId, parentId: null, body: 'hi', alsoInChannel: false, fileIds: [], now: 1,
  });
  if (!r.ok) throw new Error(r.code);
  return r.message.id;
}

const cid = (p: string, i: number) => `${p}-${i}-xxxxxxxx`;

/** Collects `n` ack/nack answers for the given clientIds (any order). */
async function answers(sock: TestSocket, n: number): Promise<{ acks: string[]; nacks: { clientId: string; code: string }[] }> {
  const acks: string[] = [];
  const nacks: { clientId: string; code: string }[] = [];
  // ack and nack frames are queued independently by the helper; wait until n answers are in.
  const deadline = Date.now() + 5_000;
  while (acks.length + nacks.length < n) {
    if (Date.now() > deadline) throw new Error(`only ${acks.length} acks / ${nacks.length} nacks`);
    const ack = sock.frames.filter((f) => f.t === 'ack').length;
    const nack = sock.frames.filter((f) => f.t === 'nack').length;
    if (ack + nack >= n) {
      for (const f of sock.frames) {
        if (f.t === 'ack') acks.push(f.clientId);
        if (f.t === 'nack') nacks.push({ clientId: f.clientId, code: f.code });
      }
      break;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  return { acks, nacks };
}

describe('takeFrameBudget (token bucket)', () => {
  it('uses 10 frames/s with a burst of 20; typing costs 0.2', () => {
    expect(FRAME_BUDGET_PER_SEC).toBe(10);
    expect(FRAME_BUDGET_BURST).toBe(20);
    expect(TYPING_FRAME_COST).toBe(0.2);
  });

  it('starts full, drains, refills at the rate and caps at the burst', () => {
    let b: { tokens: number; at: number } | undefined;
    let ok = 0;
    for (let i = 0; i < 25; i++) {
      const r = takeFrameBudget(b, 1, T);
      b = r.budget;
      if (r.ok) ok++;
    }
    expect(ok).toBe(20);
    expect(takeFrameBudget(b, 1, T + 99).ok).toBe(false); // 0.99 tokens
    const r = takeFrameBudget(b, 1, T + 100);
    expect(r.ok).toBe(true);
    expect(takeFrameBudget(b, 1, T + 3_600_000).budget.tokens).toBe(19); // capped at 20, minus 1
    expect(takeFrameBudget(b, 1, T - 5_000).ok).toBe(false); // a clock going backwards refills nothing
  });
});

describe('hub per-socket frame budget', () => {
  it('a burst from one socket is nacked rate_limited past 20; other sockets in the channel are unaffected', async () => {
    const s = await setup();
    await setClock(T);
    const alice = await connect(s.app, s.alice.cookie);
    const alice2 = await connect(s.app, s.alice.cookie);
    const bob = await connect(s.app, s.bob.cookie);
    for (let i = 0; i < 25; i++) alice.send({ t: 'send', clientId: cid('a', i), channelId: GENERAL, body: `a${i}` });
    const a = await answers(alice, 25);
    expect(a.acks).toHaveLength(20);
    expect(a.nacks).toHaveLength(5);
    for (const n of a.nacks) expect(n.code).toBe('rate_limited');
    expect(a.nacks.map((n) => n.clientId).sort()).toEqual([20, 21, 22, 23, 24].map((i) => cid('a', i)).sort());

    // bob and alice's second tab still send at once, with the clock frozen (no refill)
    bob.send({ t: 'send', clientId: cid('b', 0), channelId: GENERAL, body: 'b0' });
    expect((await bob.next('ack')).clientId).toBe(cid('b', 0));
    alice2.send({ t: 'send', clientId: cid('a2', 0), channelId: GENERAL, body: 'a2' });
    expect((await alice2.next('ack')).clientId).toBe(cid('a2', 0));

    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM messages').first<{ n: number }>();
    expect(n!.n).toBe(22);

    // after 1 s, ten more tokens
    await setClock(T + 1_000);
    alice.frames.length = 0;
    for (let i = 30; i < 41; i++) alice.send({ t: 'send', clientId: cid('a', i), channelId: GENERAL, body: `a${i}` });
    const b = await answers(alice, 11);
    expect(b.acks).toHaveLength(10);
    expect(b.nacks).toEqual([{ clientId: cid('a', 40), code: 'rate_limited' }]);
  });

  it('over budget: frames with a clientId are nacked, frames without one are dropped, nothing is processed', async () => {
    const s = await setup();
    const ms: string[] = [];
    for (let i = 0; i < 20; i++) ms.push(await say(s.bob.userId));
    const m = ms[0]!;
    await setClock(T);
    const alice = await connect(s.app, s.alice.cookie);
    const bob = await connect(s.app, s.bob.cookie);
    for (const id of ms) alice.send({ t: 'react', messageId: id, emoji: '+1', on: true });
    for (let i = 0; i < 20; i++) await bob.next('reaction');
    const before = (await env.DB.prepare('SELECT COUNT(*) AS n FROM reactions').first<{ n: number }>())!.n;

    alice.send({ t: 'react', messageId: m, emoji: 'tada', on: true }); // no clientId: dropped
    alice.send({ t: 'edit', messageId: m, body: 'x' }); // no clientId: dropped
    alice.send({ t: 'typing', channelId: GENERAL }); // dropped
    alice.send({ t: 'react', messageId: m, emoji: 'tada', on: true, clientId: cid('r', 1) });
    alice.send({ t: 'delete', messageId: m, clientId: cid('d', 1) });
    expect(await alice.next('nack')).toEqual({ t: 'nack', clientId: cid('r', 1), code: 'rate_limited' });
    expect(await alice.next('nack')).toEqual({ t: 'nack', clientId: cid('d', 1), code: 'rate_limited' });
    await bob.none('reaction');
    await bob.none('typing');
    await alice.none('nack');
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM reactions').first<{ n: number }>())!.n).toBe(before);
    expect((await env.DB.prepare('SELECT deleted_at FROM messages WHERE id = ?').bind(m).first<{ deleted_at: number | null }>())!.deleted_at).toBeNull();

    // uncounted frames still work over budget
    alice.send({ t: 'hello', lastSeen: {} });
    await alice.next('catchup');
  });

  it('typing costs 0.2: 10 sends + 50 typing use the whole burst', async () => {
    const s = await setup();
    await setClock(T);
    const alice = await connect(s.app, s.alice.cookie);
    const bob = await connect(s.app, s.bob.cookie);
    for (let i = 0; i < 50; i++) alice.send({ t: 'typing', channelId: GENERAL });
    for (let i = 0; i < 10; i++) alice.send({ t: 'send', clientId: cid('t', i), channelId: GENERAL, body: `t${i}` });
    alice.send({ t: 'send', clientId: cid('t', 10), channelId: GENERAL, body: 'over' });
    const a = await answers(alice, 11);
    expect(a.acks).toHaveLength(10);
    expect(a.nacks).toEqual([{ clientId: cid('t', 10), code: 'rate_limited' }]);
    for (let i = 0; i < 50; i++) await bob.next('typing');
    alice.send({ t: 'typing', channelId: GENERAL });
    await bob.none('typing');
  });

  it('the budget lives in the socket attachment and survives hibernation', async () => {
    const s = await setup();
    await setClock(T);
    const alice = await connect(s.app, s.alice.cookie);
    for (let i = 0; i < 20; i++) alice.send({ t: 'send', clientId: cid('h', i), channelId: GENERAL, body: `h${i}` });
    expect((await answers(alice, 20)).acks).toHaveLength(20);
    const budget = await runInDurableObject(hubStub(), (_hub, state) => state.getWebSockets(s.alice.userId).map((ws) => getAtt(ws).budget));
    expect(budget).toEqual([{ tokens: 0, at: T }]);
    await evictDurableObject(hubStub());
    await setClock(T); // the fresh instance gets the same frozen clock
    alice.send({ t: 'send', clientId: cid('h', 99), channelId: GENERAL, body: 'after' });
    expect(await alice.next('nack')).toEqual({ t: 'nack', clientId: cid('h', 99), code: 'rate_limited' });
  });
});
