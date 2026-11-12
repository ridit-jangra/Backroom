import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CustomEmoji, Message } from '@backroom/protocol';
import { createApp } from '../src/app';
import { sendMessage } from '../src/messaging/store';
import { GENERAL, captureMailer, insertChannel, resetDb, send, seedUsers, testDeps } from './helpers';
import { closeAll, connect, hubStub, type TestSocket } from './ws';

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
type S = Awaited<ReturnType<typeof setup>>;

async function say(channelId: string, userId: string): Promise<string> {
  const r = await sendMessage(env.DB, {
    clientId: crypto.randomUUID(), channelId, userId, parentId: null, body: 'hi', alsoInChannel: false, fileIds: [], now: 1,
  });
  if (!r.ok) throw new Error(r.code);
  return r.message.id;
}

async function connectAll(s: S) {
  return {
    owner: await connect(s.app, s.owner.cookie),
    alice: await connect(s.app, s.alice.cookie),
    bob: await connect(s.app, s.bob.cookie),
    carol: await connect(s.app, s.carol.cookie),
  };
}

const rowCount = async (m: string) =>
  (await env.DB.prepare('SELECT COUNT(*) AS n FROM reactions WHERE message_id = ?').bind(m).first<{ n: number }>())!.n;

describe('hub reactions', () => {
  it('react broadcasts reaction to channel members including the sender', async () => {
    const s = await setup();
    const m = await say(GENERAL, s.alice.userId);
    const { alice, bob, carol } = await connectAll(s);
    alice.send({ t: 'react', messageId: m, emoji: '+1', on: true });
    const expected = { t: 'reaction', channelId: GENERAL, messageId: m, emoji: '+1', userId: s.alice.userId, on: true };
    for (const sock of [alice, bob, carol]) expect(await sock.next('reaction')).toEqual(expected);
    expect(await rowCount(m)).toBe(1);
  });

  it('aliases collapse into one reaction; tones stay distinct', async () => {
    const s = await setup();
    const m = await say(GENERAL, s.alice.userId);
    const { owner, alice, bob, carol } = await connectAll(s);
    // Await each sender's own frame so first-reaction order is defined (P3-R12).
    const steps: [TestSocket, string][] = [
      [alice, 'thumbsup'],
      [bob, '+1'],
      [carol, 'wave::skin-tone-3'],
      [owner, 'wave'],
    ];
    const users = [s.alice.userId, s.bob.userId, s.carol.userId, s.owner.userId];
    for (const [i, [sock, emoji]] of steps.entries()) {
      sock.send({ t: 'react', messageId: m, emoji, on: true });
      // Earlier senders' frames are queued on this socket too: wait for our own.
      let f = await sock.next('reaction');
      while (f.userId !== users[i]) f = await sock.next('reaction');
      expect(['+1', 'wave::skin-tone-3', 'wave']).toContain(f.emoji);
    }
    const { results } = await env.DB.prepare(
      'SELECT emoji, COUNT(*) AS n FROM reactions WHERE message_id = ? GROUP BY emoji ORDER BY emoji',
    )
      .bind(m)
      .all<{ emoji: string; n: number }>();
    expect(results.map((r) => [r.emoji, r.n])).toEqual([['+1', 2], ['wave', 1], ['wave::skin-tone-3', 1]]);
    const res = await send(s.app, 'GET', `/channels/${GENERAL}/messages`, undefined, s.alice.cookie);
    const { messages } = (await res.json()) as { messages: Message[] };
    expect(messages.find((x) => x.id === m)!.reactions).toEqual([
      { emoji: '+1', userIds: [s.alice.userId, s.bob.userId] },
      { emoji: 'wave::skin-tone-3', userIds: [s.carol.userId] },
      { emoji: 'wave', userIds: [s.owner.userId] },
    ]);
  });

  it('repeating a reaction answers only the sender', async () => {
    const s = await setup();
    const m = await say(GENERAL, s.alice.userId);
    const { alice, bob } = await connectAll(s);
    alice.send({ t: 'react', messageId: m, emoji: '+1', on: true });
    await alice.next('reaction');
    await bob.next('reaction');
    alice.send({ t: 'react', messageId: m, emoji: 'thumbsup', on: true });
    expect(await alice.next('reaction')).toMatchObject({ emoji: '+1', on: true });
    await bob.none('reaction');
    expect(await rowCount(m)).toBe(1);
  });

  it('off broadcasts on:false', async () => {
    const s = await setup();
    const m = await say(GENERAL, s.alice.userId);
    const { alice, bob } = await connectAll(s);
    alice.send({ t: 'react', messageId: m, emoji: '+1', on: true });
    await bob.next('reaction');
    alice.send({ t: 'react', messageId: m, emoji: '+1', on: false });
    expect(await bob.next('reaction')).toMatchObject({ emoji: '+1', userId: s.alice.userId, on: false });
    expect(await rowCount(m)).toBe(0);
  });

  it('unknown emoji nacks invalid with clientId; is silent without one', async () => {
    const s = await setup();
    const m = await say(GENERAL, s.alice.userId);
    const { alice } = await connectAll(s);
    alice.send({ t: 'react', messageId: m, emoji: 'nosuchemoji', on: true, clientId: 'react-1-xxxxxx' });
    expect(await alice.next('nack')).toEqual({ t: 'nack', clientId: 'react-1-xxxxxx', code: 'invalid' });
    alice.send({ t: 'react', messageId: m, emoji: 'nosuchemoji', on: true });
    await alice.none('nack');
    await alice.none('reaction');
    expect(await rowCount(m)).toBe(0);
  });

  it('private channel isolation', async () => {
    const s = await setup();
    const priv = await insertChannel({ name: 'secret', kind: 'private', memberIds: [s.alice.userId, s.bob.userId] });
    const m = await say(priv, s.alice.userId);
    const { alice, bob, carol } = await connectAll(s);
    carol.send({ t: 'react', messageId: m, emoji: '+1', on: true, clientId: 'react-2-xxxxxx' });
    expect(await carol.next('nack')).toEqual({ t: 'nack', clientId: 'react-2-xxxxxx', code: 'not_found' });
    expect(await rowCount(m)).toBe(0);
    alice.send({ t: 'react', messageId: m, emoji: '+1', on: true });
    await alice.next('reaction');
    await bob.next('reaction');
    await carol.none('reaction', 200);
  });

  it('react on a deleted message nacks not_found; in an archived channel nacks archived', async () => {
    const s = await setup();
    const gone = await say(GENERAL, s.alice.userId);
    await env.DB.prepare('UPDATE messages SET deleted_at = 2 WHERE id = ?').bind(gone).run();
    const ch = await insertChannel({ name: 'old', kind: 'public', memberIds: [s.alice.userId, s.owner.userId], createdBy: s.owner.userId });
    const m = await say(ch, s.alice.userId);
    const { alice } = await connectAll(s);
    alice.send({ t: 'react', messageId: gone, emoji: '+1', on: true, clientId: 'react-3-xxxxxx' });
    expect(await alice.next('nack')).toEqual({ t: 'nack', clientId: 'react-3-xxxxxx', code: 'not_found' });
    expect(await rowCount(gone)).toBe(0);

    const res = await send(s.app, 'PATCH', `/channels/${ch}`, { archived: true }, s.owner.cookie);
    expect(res.status).toBe(200);
    alice.send({ t: 'react', messageId: m, emoji: '+1', on: true, clientId: 'react-4-xxxxxx' });
    expect(await alice.next('nack')).toEqual({ t: 'nack', clientId: 'react-4-xxxxxx', code: 'archived' });
    // A socket that connects after archiving no longer has the channel at all.
    const late = await connect(s.app, s.alice.cookie);
    late.send({ t: 'react', messageId: m, emoji: '+1', on: true, clientId: 'react-5-xxxxxx' });
    expect(await late.next('nack')).toEqual({ t: 'nack', clientId: 'react-5-xxxxxx', code: 'not_found' });
    expect(await rowCount(m)).toBe(0);
  });

  it('message.new and a fresh ack carry reactions []; a replayed ack omits it', async () => {
    const s = await setup();
    const { alice, bob } = await connectAll(s);
    const frame = { t: 'send', clientId: 'rx-send-xxxxxx', channelId: GENERAL, body: 'hello' } as const;
    alice.send(frame);
    const ack = await alice.next('ack');
    expect(ack.message.reactions).toEqual([]);
    expect((await bob.next('message.new')).message.reactions).toEqual([]);

    alice.send({ t: 'react', messageId: ack.message.id, emoji: '+1', on: true });
    await alice.next('reaction');
    // In-memory replay (frameFor) omits reactions.
    alice.send(frame);
    expect('reactions' in (await alice.next('ack')).message).toBe(false);
    // D1-backstop duplicate after hub eviction also omits them (P3-R5).
    await closeAll();
    await evictDurableObject(hubStub());
    const again = await connect(s.app, s.alice.cookie);
    again.send(frame);
    const dup = await again.next('ack');
    expect(dup.message.id).toBe(ack.message.id);
    expect('reactions' in dup.message).toBe(false);
  });

  it('emojiChanged reaches every socket', async () => {
    const s = await setup();
    const socks = Object.values(await connectAll(s));
    const e: CustomEmoji = { id: '01JEMOJI000000000000000001', name: 'partyparrot', url: '/emoji/01JEMOJI000000000000000001', aliasFor: null, createdBy: null, createdAt: 1 };
    await hubStub().emojiChanged({ added: [e], removed: ['old'] });
    for (const sock of socks) {
      const f = await sock.next('emoji.update');
      expect(f.added[0]!.name).toBe(e.name);
      expect(f.removed).toEqual(['old']);
    }
  });
});
