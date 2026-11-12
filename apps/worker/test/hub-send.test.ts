import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { sendMessage } from '../src/messaging/store';
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

/** Connects everyone after any channels a test inserted, so their attachments include them. */
async function connectAll(s: Awaited<ReturnType<typeof setup>>) {
  return {
    owner: await connect(s.app, s.owner.cookie),
    alice: await connect(s.app, s.alice.cookie),
    bob: await connect(s.app, s.bob.cookie),
    carol: await connect(s.app, s.carol.cookie),
  };
}

const countMessages = async () =>
  (await env.DB.prepare('SELECT COUNT(*) AS n FROM messages').first<{ n: number }>())!.n;
const lastSeq = async (id = GENERAL) =>
  (await env.DB.prepare('SELECT last_seq FROM channels WHERE id=?').bind(id).first<{ last_seq: number }>())!.last_seq;

describe('hub send', () => {
  it('seq ordering under concurrent sends', async () => {
    const { alice, bob, carol } = await connectAll(await setup());
    for (let i = 0; i < 10; i++) {
      alice.send({ t: 'send', clientId: `a-${i}-xxxxxx`, channelId: GENERAL, body: `a${i}` });
      bob.send({ t: 'send', clientId: `b-${i}-xxxxxx`, channelId: GENERAL, body: `b${i}` });
    }
    const seen: number[] = [];
    for (let i = 0; i < 20; i++) seen.push((await carol.next('message.new')).message.seq);
    expect(seen).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(await lastSeq()).toBe(20);
  });

  it("sender gets ack, others get message.new, sender's socket gets no message.new", async () => {
    const s = await setup();
    const { alice, bob } = await connectAll(s);
    const alice2 = await connect(s.app, s.alice.cookie);
    alice.send({ t: 'send', clientId: 'c-1-xxxxxx', channelId: GENERAL, body: 'hello' });
    const ack = await alice.next('ack');
    expect(ack.clientId).toBe('c-1-xxxxxx');
    expect(ack.message).toMatchObject({ body: 'hello', channelId: GENERAL, seq: 1, userId: s.alice.userId });
    expect((await bob.next('message.new')).message.id).toBe(ack.message.id);
    expect((await alice2.next('message.new')).message.id).toBe(ack.message.id);
    await alice.none('message.new');
  });

  it('duplicate clientId returns the same ack once stored', async () => {
    const { alice, carol } = await connectAll(await setup());
    const frame = { t: 'send', clientId: 'dup-1-xxxxxx', channelId: GENERAL, body: 'once' } as const;
    alice.send(frame);
    alice.send(frame);
    const a1 = await alice.next('ack');
    const a2 = await alice.next('ack');
    expect(a2.message.id).toBe(a1.message.id);
    await carol.next('message.new');
    await carol.none('message.new');
    expect(await countMessages()).toBe(1);
  });

  it('duplicate clientId after hub eviction returns the original ack', async () => {
    const s = await setup();
    const { alice } = await connectAll(s);
    const frame = { t: 'send', clientId: 'evict-1-xxxxxx', channelId: GENERAL, body: 'survive' } as const;
    alice.send(frame);
    const first = await alice.next('ack');
    await closeAll();
    await evictDurableObject(hubStub());
    const again = await connect(s.app, s.alice.cookie);
    const carol = await connect(s.app, s.carol.cookie);
    again.send(frame);
    expect((await again.next('ack')).message.id).toBe(first.message.id);
    await carol.none('message.new');
    expect(await countMessages()).toBe(1);
  });

  it('D1 failure nacks failed without consuming seq', async () => {
    const s = await setup();
    await env.DB.prepare(
      "INSERT INTO messages (id, channel_id, seq, user_id, body, created_at) VALUES ('01JRAWROW0000000000000000A', ?, 1, ?, 'raw', 1)",
    )
      .bind(GENERAL, s.owner.userId)
      .run();
    const { alice, carol } = await connectAll(s);
    alice.send({ t: 'send', clientId: 'fail-1-xxxxxx', channelId: GENERAL, body: 'boom' });
    expect(await alice.next('nack')).toEqual({ t: 'nack', clientId: 'fail-1-xxxxxx', code: 'failed' });
    await carol.none('message.new');
    expect(await lastSeq()).toBe(0);
  });

  it('a nacked clientId can be retried', async () => {
    const s = await setup();
    await env.DB.prepare(
      "INSERT INTO messages (id, channel_id, seq, user_id, body, created_at) VALUES ('01JRAWROW0000000000000000A', ?, 1, ?, 'raw', 1)",
    )
      .bind(GENERAL, s.owner.userId)
      .run();
    const { alice } = await connectAll(s);
    const frame = { t: 'send', clientId: 'retry-1-xxxxxx', channelId: GENERAL, body: 'again' } as const;
    alice.send(frame);
    expect((await alice.next('nack')).code).toBe('failed');
    await env.DB.prepare("DELETE FROM messages WHERE id='01JRAWROW0000000000000000A'").run();
    alice.send(frame);
    expect((await alice.next('ack')).message.seq).toBe(1);
  });

  it('40,001-char body is nacked too_long; 40,000 is acked', async () => {
    const { alice } = await connectAll(await setup());
    alice.send({ t: 'send', clientId: 'long-1-xxxxxx', channelId: GENERAL, body: 'x'.repeat(40_001) });
    expect(await alice.next('nack')).toEqual({ t: 'nack', clientId: 'long-1-xxxxxx', code: 'too_long' });
    alice.send({ t: 'send', clientId: 'long-2-xxxxxx', channelId: GENERAL, body: 'x'.repeat(40_000) });
    expect((await alice.next('ack')).message.body.length).toBe(40_000);
    expect(await countMessages()).toBe(1);
  });

  it('an invalid frame with a clientId is nacked invalid', async () => {
    const { alice } = await connectAll(await setup());
    alice.send(JSON.stringify({ t: 'send', clientId: 'bad-1-xxxxxx', channelId: 'nope', body: 'x' }));
    expect(await alice.next('nack')).toEqual({ t: 'nack', clientId: 'bad-1-xxxxxx', code: 'invalid' });
  });

  it('private channel isolation', async () => {
    const s = await setup();
    const priv = await insertChannel({ name: 'secret', kind: 'private', memberIds: [s.alice.userId, s.bob.userId] });
    const { alice, bob, carol } = await connectAll(s);
    alice.send({ t: 'send', clientId: 'priv-1-xxxxxx', channelId: priv, body: 'psst' });
    const ack = await alice.next('ack');
    expect((await bob.next('message.new')).message.id).toBe(ack.message.id);
    await carol.none('message.new', 200);

    carol.send({ t: 'send', clientId: 'priv-2-xxxxxx', channelId: priv, body: 'let me in' });
    expect(await carol.next('nack')).toEqual({ t: 'nack', clientId: 'priv-2-xxxxxx', code: 'not_found' });
    carol.send({ t: 'edit', messageId: ack.message.id, body: 'hacked', clientId: 'priv-3-xxxxxx' });
    expect(await carol.next('nack')).toEqual({ t: 'nack', clientId: 'priv-3-xxxxxx', code: 'not_found' });
    carol.send({ t: 'delete', messageId: ack.message.id, clientId: 'priv-4-xxxxxx' });
    expect(await carol.next('nack')).toEqual({ t: 'nack', clientId: 'priv-4-xxxxxx', code: 'not_found' });
    await bob.none('message.edit');
    await bob.none('message.delete');
    expect(await countMessages()).toBe(1);
  });

  it('send to an unknown channel is nacked not_found', async () => {
    const { alice } = await connectAll(await setup());
    alice.send({ t: 'send', clientId: 'unk-1-xxxxxx', channelId: '01JNOSUCHCHANNEL0000000000', body: 'hi' });
    expect(await alice.next('nack')).toEqual({ t: 'nack', clientId: 'unk-1-xxxxxx', code: 'not_found' });
  });
});

describe('hub edit/delete', () => {
  it('edit by author broadcasts message.edit to all members; by another member nacks forbidden', async () => {
    const { alice, bob, carol } = await connectAll(await setup());
    alice.send({ t: 'send', clientId: 'ed-1-xxxxxx', channelId: GENERAL, body: 'v1' });
    const { message } = await alice.next('ack');
    alice.send({ t: 'edit', messageId: message.id, body: 'v2' });
    for (const s of [alice, bob, carol]) {
      const e = await s.next('message.edit');
      expect(e.message).toMatchObject({ id: message.id, body: 'v2' });
      expect(e.message.editedAt).not.toBeNull();
    }
    bob.send({ t: 'edit', messageId: message.id, body: 'mine now', clientId: 'ed-2-xxxxxx' });
    expect(await bob.next('nack')).toEqual({ t: 'nack', clientId: 'ed-2-xxxxxx', code: 'forbidden' });
    await carol.none('message.edit');
  });

  it('a failed edit without clientId sends nothing', async () => {
    const { bob } = await connectAll(await setup());
    bob.send({ t: 'edit', messageId: '01JNOSUCHMESSAGE0000000000', body: 'x' });
    await bob.none('nack');
  });

  it('delete broadcasts placeholder', async () => {
    const { alice, bob } = await connectAll(await setup());
    alice.send({ t: 'send', clientId: 'del-1-xxxxxx', channelId: GENERAL, body: 'oops' });
    const { message } = await alice.next('ack');
    alice.send({ t: 'delete', messageId: message.id });
    for (const s of [alice, bob]) {
      const d = await s.next('message.delete');
      expect(d.message.id).toBe(message.id);
      expect(d.message.body).toBe('');
      expect(d.message.deletedAt).not.toBeNull();
    }
  });

  it('reply is broadcast to channel members with parentId set', async () => {
    const { alice, bob, carol } = await connectAll(await setup());
    alice.send({ t: 'send', clientId: 'par-1-xxxxxx', channelId: GENERAL, body: 'parent' });
    const parent = (await alice.next('ack')).message;
    await bob.next('message.new');
    await carol.next('message.new');
    bob.send({ t: 'send', clientId: 'rep-1-xxxxxx', channelId: GENERAL, parentId: parent.id, body: 'reply' });
    const ack = await bob.next('ack');
    expect(ack.message.parentId).toBe(parent.id);
    for (const s of [alice, carol]) {
      const n = await s.next('message.new');
      expect(n.message).toMatchObject({ id: ack.message.id, parentId: parent.id, seq: 2 });
    }
  });

  it('reply to a deleted parent is nacked invalid', async () => {
    const s = await setup();
    const parent = await sendMessage(env.DB, {
      clientId: 'seed-parent-1',
      channelId: GENERAL,
      userId: s.alice.userId,
      parentId: null,
      body: 'parent',
      alsoInChannel: false,
      fileIds: [],
      now: 1_000,
    });
    if (!parent.ok) throw new Error(parent.code);
    await env.DB.prepare("UPDATE messages SET deleted_at = 2000, body = '' WHERE id = ?").bind(parent.message.id).run();
    const { bob, carol } = await connectAll(s);
    bob.send({ t: 'send', clientId: 'rep-2-xxxxxx', channelId: GENERAL, parentId: parent.message.id, body: 'late' });
    expect(await bob.next('nack')).toEqual({ t: 'nack', clientId: 'rep-2-xxxxxx', code: 'invalid' });
    await carol.none('message.new');
    expect(await lastSeq()).toBe(1);
  });
});
