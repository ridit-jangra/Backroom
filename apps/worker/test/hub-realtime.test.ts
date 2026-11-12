import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { GENERAL, captureMailer, insertChannel, resetDb, seedUsers, testDeps } from './helpers';
import { closeAll, connect, hubStub } from './ws';

beforeEach(resetDb);
afterEach(async () => {
  await closeAll();
  await runInDurableObject(hubStub(), (hub) => {
    hub.now = () => Date.now();
  });
  await runDurableObjectAlarm(hubStub());
});

async function setup() {
  const { mailer, sent } = captureMailer();
  const app = createApp(testDeps({ mailer }));
  const [owner, alice, bob, carol] = await seedUsers(app, sent, [
    'owner@test.dev',
    'alice@test.dev',
    'bob@test.dev',
    'carol@test.dev',
  ]);
  return { app, owner: owner!, alice: alice!, bob: bob!, carol: carol! };
}

/** Gives GENERAL three messages so last_seq is 3. */
async function seedMessages(userId: string, n = 3) {
  await env.DB.batch(
    Array.from({ length: n }, (_, i) =>
      env.DB.prepare(
        `INSERT INTO messages (id, channel_id, seq, user_id, body, created_at) VALUES (?, ?, ?, ?, 'x', 1)`,
      ).bind(`01JRAWROW00000000000000${String(i).padStart(3, '0')}`, GENERAL, i + 1, userId),
    ).concat(env.DB.prepare('UPDATE channels SET last_seq = ? WHERE id = ?').bind(n, GENERAL)),
  );
}

const readSeq = async (userId: string) =>
  (await env.DB.prepare('SELECT last_read_seq AS v FROM channel_members WHERE channel_id=? AND user_id=?')
    .bind(GENERAL, userId)
    .first<{ v: number }>())!.v;

describe('hub read state', () => {
  it("mark_read sends read to the user's other sockets only", async () => {
    const s = await setup();
    await seedMessages(s.owner.userId);
    const a1 = await connect(s.app, s.alice.cookie);
    const a2 = await connect(s.app, s.alice.cookie);
    const bob = await connect(s.app, s.bob.cookie);
    a1.send({ t: 'mark_read', channelId: GENERAL, seq: 2 });
    expect(await a2.next('read')).toEqual({ t: 'read', channelId: GENERAL, seq: 2 });
    await a1.none('read');
    await bob.none('read');
    expect(await readSeq(s.alice.userId)).toBe(2);
  });

  it('mark_read is coalesced to one write per second', async () => {
    const s = await setup();
    await seedMessages(s.owner.userId);
    const a1 = await connect(s.app, s.alice.cookie);
    const a2 = await connect(s.app, s.alice.cookie);
    for (const seq of [1, 2, 3]) a1.send({ t: 'mark_read', channelId: GENERAL, seq });
    expect((await a2.next('read')).seq).toBe(1);
    expect((await a2.next('read', 1_500)).seq).toBe(3);
    await a2.none('read', 300);
    expect(a2.frames.filter((f) => f.t === 'read').map((f) => (f as { seq: number }).seq)).toEqual([1, 3]);
  });

  it('mark_read never moves backwards or past last_seq', async () => {
    const s = await setup();
    await seedMessages(s.owner.userId);
    const a1 = await connect(s.app, s.alice.cookie);
    const a2 = await connect(s.app, s.alice.cookie);
    a1.send({ t: 'mark_read', channelId: GENERAL, seq: 3 });
    expect((await a2.next('read')).seq).toBe(3);
    await new Promise((r) => setTimeout(r, 100)); // let the first write settle
    a1.send({ t: 'mark_read', channelId: GENERAL, seq: 1 });
    await a2.none('read', 300);
    expect(await readSeq(s.alice.userId)).toBe(3);

    const b1 = await connect(s.app, s.bob.cookie);
    const b2 = await connect(s.app, s.bob.cookie);
    b1.send({ t: 'mark_read', channelId: GENERAL, seq: 99 });
    expect((await b2.next('read')).seq).toBe(3);
    expect(await readSeq(s.bob.userId)).toBe(3);
  });

  it('mark_read for a channel the socket is not in is ignored', async () => {
    const s = await setup();
    const priv = await insertChannel({ name: 'secret', kind: 'private', memberIds: [s.bob.userId] });
    await env.DB.prepare('UPDATE channels SET last_seq = 5 WHERE id = ?').bind(priv).run();
    const a1 = await connect(s.app, s.alice.cookie);
    a1.send({ t: 'mark_read', channelId: priv, seq: 2 });
    await new Promise((r) => setTimeout(r, 150));
    const v = await env.DB.prepare('SELECT last_read_seq AS v FROM channel_members WHERE channel_id=? AND user_id=?')
      .bind(priv, s.bob.userId)
      .first<{ v: number }>();
    expect(v!.v).toBe(0);
  });

  it('mark_thread_read advances last_read_reply_seq', async () => {
    const s = await setup();
    const root = '01JRAWROW0000000000000ROOT';
    await env.DB.batch([
      env.DB.prepare("INSERT INTO messages (id, channel_id, seq, user_id, body, created_at) VALUES (?, ?, 1, ?, 'r', 1)").bind(root, GENERAL, s.owner.userId),
      env.DB.prepare('INSERT INTO thread_follows (message_id, user_id, last_read_reply_seq) VALUES (?, ?, 0)').bind(root, s.alice.userId),
    ]);
    const a1 = await connect(s.app, s.alice.cookie);
    a1.send({ t: 'mark_thread_read', messageId: root, seq: 4 });
    await new Promise((r) => setTimeout(r, 200));
    const v = await env.DB.prepare('SELECT last_read_reply_seq AS v FROM thread_follows WHERE message_id=? AND user_id=?')
      .bind(root, s.alice.userId)
      .first<{ v: number }>();
    expect(v!.v).toBe(4);
  });
});

describe('hub typing', () => {
  it('typing reaches other members, not the sender or non-members', async () => {
    const s = await setup();
    const priv = await insertChannel({ name: 'secret', kind: 'private', memberIds: [s.alice.userId, s.bob.userId] });
    const a1 = await connect(s.app, s.alice.cookie);
    const a2 = await connect(s.app, s.alice.cookie);
    const bob = await connect(s.app, s.bob.cookie);
    const carol = await connect(s.app, s.carol.cookie);
    a1.send({ t: 'typing', channelId: priv });
    expect(await bob.next('typing')).toEqual({ t: 'typing', channelId: priv, userId: s.alice.userId });
    await a1.none('typing');
    await a2.none('typing');
    await carol.none('typing');
  });

  it('typing in a channel the socket is not in is dropped', async () => {
    const s = await setup();
    const priv = await insertChannel({ name: 'secret', kind: 'private', memberIds: [s.bob.userId] });
    const bob = await connect(s.app, s.bob.cookie);
    const carol = await connect(s.app, s.carol.cookie);
    carol.send({ t: 'typing', channelId: priv });
    await bob.none('typing');
  });
});

describe('hub notifications', () => {
  it('DM message notifies the recipient only', async () => {
    const s = await setup();
    const dm = await insertChannel({
      name: null,
      kind: 'dm',
      memberIds: [s.alice.userId, s.bob.userId],
      dmKey: [s.alice.userId, s.bob.userId].sort().join(','),
    });
    const alice = await connect(s.app, s.alice.cookie);
    const bob = await connect(s.app, s.bob.cookie);
    const carol = await connect(s.app, s.carol.cookie);
    alice.send({ t: 'send', clientId: 'dm-1-xxxxxx', channelId: dm, body: 'psst' });
    await alice.next('ack');
    expect(await bob.next('notify')).toMatchObject({
      kind: 'dm',
      channelId: dm,
      parentId: null,
      fromUserId: s.alice.userId,
      preview: 'psst',
    });
    await alice.none('notify');
    await carol.none('notify');
  });

  it('@here notifies active members only', async () => {
    const s = await setup();
    const alice = await connect(s.app, s.alice.cookie);
    const bob = await connect(s.app, s.bob.cookie);
    const carol = await connect(s.app, s.carol.cookie);
    bob.send({ t: 'activity' });
    await alice.next('presence'); // bob became active
    alice.send({ t: 'send', clientId: 'here-1-xxxxxx', channelId: GENERAL, body: '@here standup' });
    await alice.next('ack');
    expect((await bob.next('notify')).kind).toBe('here');
    await carol.none('notify');
  });

  it('a mention carries a 140-char preview', async () => {
    const s = await setup();
    const alice = await connect(s.app, s.alice.cookie);
    const bob = await connect(s.app, s.bob.cookie);
    alice.send({ t: 'send', clientId: 'pv-1-xxxxxxx', channelId: GENERAL, body: `<@${s.bob.userId}> ${'y'.repeat(300)}` });
    await alice.next('ack');
    const n = await bob.next('notify');
    expect(n.kind).toBe('mention');
    expect(n.preview.length).toBe(140);
  });

  it('a throwing notify still acks the sender and broadcasts', async () => {
    const s = await setup();
    await runInDurableObject(hubStub(), (hub) => {
      (hub as unknown as { notify: () => void }).notify = () => {
        throw new Error('boom');
      };
    });
    const alice = await connect(s.app, s.alice.cookie);
    const bob = await connect(s.app, s.bob.cookie);
    const frame = { t: 'send', clientId: 'nt-1-xxxxxxx', channelId: GENERAL, body: 'hello' } as const;
    alice.send(frame);
    const ack = await alice.next('ack');
    expect((await bob.next('message.new')).message.id).toBe(ack.message.id);
    // A retry of the same clientId replays the ack (reloaded from D1), not a stuck rejection.
    alice.send(frame);
    expect((await alice.next('ack')).message.id).toBe(ack.message.id);
    await runInDurableObject(hubStub(), (hub) => {
      delete (hub as unknown as { notify?: () => void }).notify;
    });
  });
});
