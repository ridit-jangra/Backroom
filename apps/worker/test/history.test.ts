import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { HistoryPage, Message, ThreadPage } from '@backroom/protocol';
import { createApp } from '../src/app';
import { catchUp } from '../src/messaging/read';
import { deleteMessage, sendMessage } from '../src/messaging/store';
import { GENERAL, captureMailer, insertChannel, resetDb, seedUsers, send, testDeps } from './helpers';

beforeEach(resetDb);

async function setup() {
  const { mailer, sent } = captureMailer();
  const app = createApp(testDeps({ mailer }));
  const [owner, alice, bob] = await seedUsers(app, sent, ['owner@test.dev', 'alice@test.dev', 'bob@test.dev']);
  const say = async (o: { channelId?: string; userId?: string; parentId?: string | null; alsoInChannel?: boolean; body?: string } = {}) => {
    const r = await sendMessage(env.DB, {
      clientId: crypto.randomUUID(),
      channelId: o.channelId ?? GENERAL,
      userId: o.userId ?? alice!.userId,
      parentId: o.parentId ?? null,
      body: o.body ?? 'hi',
      alsoInChannel: o.alsoInChannel ?? false,
      fileIds: [],
      now: 1_000,
    });
    if (!r.ok) throw new Error(r.code);
    return r.message;
  };
  const get = (path: string, cookie = alice!.cookie) => send(app, 'GET', path, undefined, cookie);
  return { app, owner: owner!, alice: alice!, bob: bob!, say, get };
}

const seqs = (ms: Message[]) => ms.map((m) => m.seq);
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

describe('history paging', () => {
  it('pages backwards by seq', async () => {
    const { say, get } = await setup();
    for (let i = 0; i < 120; i++) await say();
    const p1 = (await (await get(`/channels/${GENERAL}/messages`)).json()) as HistoryPage;
    expect(seqs(p1.messages)).toEqual(range(71, 120));
    expect(p1.hasMore).toBe(true);
    const p2 = (await (await get(`/channels/${GENERAL}/messages?before=71`)).json()) as HistoryPage;
    expect(seqs(p2.messages)).toEqual(range(21, 70));
    expect(p2.hasMore).toBe(true);
    const p3 = (await (await get(`/channels/${GENERAL}/messages?before=21&limit=100`)).json()) as HistoryPage;
    expect(seqs(p3.messages)).toEqual(range(1, 20));
    expect(p3.hasMore).toBe(false);
  });

  it('after returns newer messages ascending', async () => {
    const { say, get } = await setup();
    for (let i = 0; i < 120; i++) await say();
    const p = (await (await get(`/channels/${GENERAL}/messages?after=115`)).json()) as HistoryPage;
    expect(seqs(p.messages)).toEqual([116, 117, 118, 119, 120]);
    expect(p.hasMore).toBe(false);
    const q = (await (await get(`/channels/${GENERAL}/messages?after=0&limit=10`)).json()) as HistoryPage;
    expect(seqs(q.messages)).toEqual(range(1, 10));
    expect(q.hasMore).toBe(true);
  });

  it('before and after together is 400 invalid_request; limit=101 is 400', async () => {
    const { get } = await setup();
    const a = await get(`/channels/${GENERAL}/messages?before=5&after=1`);
    expect(a.status).toBe(400);
    expect(((await a.json()) as { error: { code: string } }).error.code).toBe('invalid_request');
    expect((await get(`/channels/${GENERAL}/messages?limit=101`)).status).toBe(400);
  });

  it('channel view excludes plain replies but includes also_in_channel replies', async () => {
    const { say, get } = await setup();
    const parent = await say();
    await say({ parentId: parent.id });
    const also = await say({ parentId: parent.id, alsoInChannel: true });
    const p = (await (await get(`/channels/${GENERAL}/messages`)).json()) as HistoryPage;
    expect(seqs(p.messages)).toEqual([parent.seq, also.seq]);
  });

  it('deleted message appears as placeholder', async () => {
    const { say, get, alice } = await setup();
    const m = await say({ body: 'secret' });
    await deleteMessage(env.DB, { messageId: m.id, userId: alice.userId, now: 2_000 });
    const p = (await (await get(`/channels/${GENERAL}/messages`)).json()) as HistoryPage;
    expect(p.messages).toHaveLength(1);
    expect(p.messages[0]!.body).toBe('');
    expect(p.messages[0]!.deletedAt).toBe(2_000);
  });
});

describe('threads', () => {
  it('returns parent and replies in order; thread of a reply is 404', async () => {
    const { say, get } = await setup();
    const parent = await say();
    const r1 = await say({ parentId: parent.id });
    const r2 = await say({ parentId: parent.id });
    const page = (await (await get(`/messages/${parent.id}/thread`)).json()) as ThreadPage;
    expect(page.parent.id).toBe(parent.id);
    expect(page.replies.map((m) => m.id)).toEqual([r1.id, r2.id]);
    expect((await get(`/messages/${r1.id}/thread`)).status).toBe(404);
  });
});

describe('visibility', () => {
  it('private channel history and thread are 404 for non-members, identical to unknown IDs', async () => {
    const { say, get, owner, alice, bob } = await setup();
    const priv = await insertChannel({ name: 'secret', kind: 'private', memberIds: [owner.userId, alice.userId] });
    const m = await say({ channelId: priv });
    const unknownId = '01JZZZZZZZZZZZZZZZZZZZZZZZ';
    const a = await get(`/channels/${priv}/messages`, bob.cookie);
    const b = await get(`/channels/${unknownId}/messages`, bob.cookie);
    expect(a.status).toBe(404);
    expect(await a.json()).toEqual(await b.json());
    const c = await get(`/messages/${m.id}/thread`, bob.cookie);
    const d = await get(`/messages/${unknownId}/thread`, bob.cookie);
    expect(c.status).toBe(404);
    expect(await c.json()).toEqual(await d.json());
    expect((await get(`/channels/${priv}/messages`, alice.cookie)).status).toBe(200);
  });

  it('public channel is readable by a non-member workspace member', async () => {
    const { say, get, owner, alice, bob } = await setup();
    const pub = await insertChannel({ name: 'open', kind: 'public', memberIds: [owner.userId, alice.userId] });
    await say({ channelId: pub });
    const res = await get(`/channels/${pub}/messages`, bob.cookie);
    expect(res.status).toBe(200);
    expect(((await res.json()) as HistoryPage).messages).toHaveLength(1);
  });

  it('requires a session', async () => {
    const { app } = await setup();
    expect((await send(app, 'GET', `/channels/${GENERAL}/messages`)).status).toBe(401);
  });
});

describe('catchUp', () => {
  it('returns missed messages including replies', async () => {
    const { say } = await setup();
    const p = await say();
    await say();
    await say({ parentId: p.id });
    await say();
    await say({ parentId: p.id });
    const r = await catchUp(env.DB, [GENERAL], { [GENERAL]: 3 });
    expect(seqs(r.messages)).toEqual([4, 5]);
    expect(r.stale).toEqual([]);
  });

  it('marks a channel stale past 200', async () => {
    const { say } = await setup();
    for (let i = 0; i < 201; i++) await say();
    const a = await catchUp(env.DB, [GENERAL], { [GENERAL]: 0 });
    expect(a.stale).toEqual([GENERAL]);
    expect(a.messages).toEqual([]);
    const b = await catchUp(env.DB, [GENERAL], { [GENERAL]: 1 });
    expect(b.stale).toEqual([]);
    expect(b.messages).toHaveLength(200);
  });

  it('handles more channels than one statement can bind (120)', async () => {
    const { say, alice } = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 120; i++) ids.push(await insertChannel({ name: `c-${i}`, kind: 'public', memberIds: [alice.userId] }));
    await say({ channelId: ids[0] });
    await say({ channelId: ids[95] });
    await say({ channelId: ids[119] });
    await say({ channelId: ids[119] });
    const lastSeen = Object.fromEntries(ids.map((id) => [id, 0]));
    lastSeen[ids[119]!] = 1;
    const r = await catchUp(env.DB, ids, lastSeen);
    expect(r.stale).toEqual([]);
    expect(r.messages.map((m) => [m.channelId, m.seq])).toEqual([
      [ids[0], 1],
      [ids[95], 1],
      [ids[119], 2],
    ]);
  });

  it('ignores channels the user is not in', async () => {
    const { say, owner, alice } = await setup();
    const priv = await insertChannel({ name: 'secret', kind: 'private', memberIds: [owner.userId, alice.userId] });
    await say({ channelId: priv });
    const r = await catchUp(env.DB, [GENERAL], { [priv]: 0 });
    expect(r).toEqual({ messages: [], stale: [] });
  });
});
