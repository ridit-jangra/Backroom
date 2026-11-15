import { createExecutionContext, env, runDurableObjectAlarm, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { catchUp } from '../src/messaging/read';
import { deleteMessage, sendMessage, type SendInput } from '../src/messaging/store';
import { GENERAL, captureMailer, insertFile, resetDb, seedUsers, testDeps } from './helpers';
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
  let t = 1_000;
  const say = async (o: Partial<SendInput> & { userId: string }) => {
    const r = await sendMessage(env.DB, {
      clientId: crypto.randomUUID(),
      channelId: GENERAL,
      parentId: null,
      body: 'hi',
      alsoInChannel: false,
      fileIds: [],
      now: (t += 10),
      ...o,
    });
    if (!r.ok) throw new Error(r.code);
    return r.message;
  };
  return { app, owner: owner!, alice: alice!, bob: bob!, carol: carol!, say };
}

const row = (id: string) =>
  env.DB.prepare(
    'SELECT reply_count AS replyCount, last_reply_at AS lastReplyAt, deleted_at AS deletedAt, body FROM messages WHERE id = ?',
  )
    .bind(id)
    .first<{ replyCount: number; lastReplyAt: number | null; deletedAt: number | null; body: string }>();
const count = async (table: string, col: string, ids: string[]) =>
  (
    await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(ids))
      .first<{ n: number }>()
  )!.n;

describe('deleting a reply keeps the parent counters exact', () => {
  it('recomputes reply_count and last_reply_at from the live replies', async () => {
    const s = await setup();
    const p = await s.say({ userId: s.alice.userId });
    const r1 = await s.say({ userId: s.bob.userId, parentId: p.id });
    const r2 = await s.say({ userId: s.carol.userId, parentId: p.id });
    const r3 = await s.say({ userId: s.bob.userId, parentId: p.id });
    expect(await row(p.id)).toMatchObject({ replyCount: 3, lastReplyAt: r3.createdAt });

    const d3 = await deleteMessage(env.DB, { messageId: r3.id, userId: s.bob.userId, now: 9_000 });
    if (!d3.ok) throw new Error(d3.code);
    expect(d3.message.deletedAt).toBe(9_000);
    expect(d3.replies).toEqual([]);
    expect(d3.parent).toEqual({ id: p.id, channelId: GENERAL, replyCount: 2, lastReplyAt: r2.createdAt });
    expect(await row(p.id)).toMatchObject({ replyCount: 2, lastReplyAt: r2.createdAt });

    // A second reply deleted (the older one): count drops again, last_reply_at stays the newest live one.
    const d1 = await deleteMessage(env.DB, { messageId: r1.id, userId: s.bob.userId, now: 9_001 });
    if (!d1.ok) throw new Error(d1.code);
    expect(d1.parent).toEqual({ id: p.id, channelId: GENERAL, replyCount: 1, lastReplyAt: r2.createdAt });

    const d2 = await deleteMessage(env.DB, { messageId: r2.id, userId: s.carol.userId, now: 9_002 });
    if (!d2.ok) throw new Error(d2.code);
    expect(d2.parent).toEqual({ id: p.id, channelId: GENERAL, replyCount: 0, lastReplyAt: null });
    expect(await row(p.id)).toMatchObject({ replyCount: 0, lastReplyAt: null, deletedAt: null });
  });

  it('a second delete of the same reply is not_found and leaves the counters alone', async () => {
    const s = await setup();
    const p = await s.say({ userId: s.alice.userId });
    const r1 = await s.say({ userId: s.bob.userId, parentId: p.id });
    const r2 = await s.say({ userId: s.bob.userId, parentId: p.id });
    expect((await deleteMessage(env.DB, { messageId: r1.id, userId: s.bob.userId, now: 9_000 })).ok).toBe(true);
    expect(await deleteMessage(env.DB, { messageId: r1.id, userId: s.bob.userId, now: 9_001 })).toEqual({ ok: false, code: 'not_found' });
    expect(await row(p.id)).toMatchObject({ replyCount: 1, lastReplyAt: r2.createdAt });
  });

  it('the page of a starter carries the live count', async () => {
    const s = await setup();
    const p = await s.say({ userId: s.alice.userId });
    const r1 = await s.say({ userId: s.bob.userId, parentId: p.id });
    await s.say({ userId: s.bob.userId, parentId: p.id });
    await deleteMessage(env.DB, { messageId: r1.id, userId: s.bob.userId, now: 9_000 });
    const cu = await catchUp(env.DB, [GENERAL], { [GENERAL]: 0 });
    expect(cu.messages.find((m) => m.id === p.id)).toMatchObject({ replyCount: 1 });
  });
});

describe('deleting a thread starter deletes its replies', () => {
  it('sweeps every live reply, purges their mentions, reactions and file links, zeroes the starter, spares other threads', async () => {
    const s = await setup();
    const f1 = await insertFile({ uploaderId: s.bob.userId, createdAt: 500 });
    const f2 = await insertFile({ uploaderId: s.bob.userId, createdAt: 500 });
    const p = await s.say({ userId: s.alice.userId, body: `<@${s.bob.userId}> starter` });
    const other = await s.say({ userId: s.alice.userId, body: 'other thread' });
    const r1 = await s.say({ userId: s.bob.userId, parentId: p.id, body: `<@${s.alice.userId}> a`, fileIds: [f1] });
    const r2 = await s.say({ userId: s.carol.userId, parentId: p.id, body: `<@${s.alice.userId}> b`, fileIds: [] });
    const gone = await s.say({ userId: s.bob.userId, parentId: p.id });
    const keep = await s.say({ userId: s.bob.userId, parentId: other.id, body: `<@${s.alice.userId}> keep`, fileIds: [f2] });
    // Already deleted before the cascade: not returned again.
    expect((await deleteMessage(env.DB, { messageId: gone.id, userId: s.bob.userId, now: 8_000 })).ok).toBe(true);
    for (const m of [r1, r2, keep]) {
      await env.DB.prepare("INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, 'thumbsup', 1)")
        .bind(m.id, s.alice.userId)
        .run();
    }
    const replyIds = [r1.id, r2.id, gone.id];

    const d = await deleteMessage(env.DB, { messageId: p.id, userId: s.alice.userId, now: 9_000 });
    if (!d.ok) throw new Error(d.code);
    expect(d.message).toMatchObject({ id: p.id, deletedAt: 9_000, body: '', replyCount: 0, lastReplyAt: null });
    expect(d.parent).toBeNull();
    expect(d.replies.map((m) => m.id)).toEqual([r1.id, r2.id]); // seq order, only the ones just deleted
    expect(d.replies.every((m) => m.deletedAt === 9_000 && m.body === '' && m.parentId === p.id)).toBe(true);
    expect(d.repliesTotal).toBe(2);

    for (const id of replyIds) expect(await row(id)).toMatchObject({ body: '' });
    expect((await row(r1.id))!.deletedAt).toBe(9_000);
    expect((await row(r2.id))!.deletedAt).toBe(9_000);
    expect((await row(gone.id))!.deletedAt).toBe(8_000);
    expect(await row(p.id)).toMatchObject({ replyCount: 0, lastReplyAt: null, deletedAt: 9_000 });
    expect(await count('mentions', 'message_id', [p.id, ...replyIds])).toBe(0);
    expect(await count('reactions', 'message_id', replyIds)).toBe(0);
    expect(await count('message_files', 'message_id', replyIds)).toBe(0);
    // The other thread is untouched.
    expect(await row(other.id)).toMatchObject({ replyCount: 1, deletedAt: null });
    expect(await row(keep.id)).toMatchObject({ deletedAt: null, body: `<@${s.alice.userId}> keep` });
    expect(await count('mentions', 'message_id', [keep.id])).toBe(1);
    expect(await count('reactions', 'message_id', [keep.id])).toBe(1);
    expect(await count('message_files', 'message_id', [keep.id])).toBe(1);
    // Replies cannot be deleted a second time, and a new reply to the deleted starter is refused.
    expect(await deleteMessage(env.DB, { messageId: r1.id, userId: s.bob.userId, now: 9_001 })).toEqual({ ok: false, code: 'not_found' });
    const late = await sendMessage(env.DB, {
      clientId: crypto.randomUUID(), channelId: GENERAL, userId: s.carol.userId, parentId: p.id,
      body: 'late', alsoInChannel: false, fileIds: [], now: 9_100,
    });
    expect(late).toEqual({ ok: false, code: 'invalid' });
  });

  it('a third user is refused and nothing changes; an admin may cascade', async () => {
    const s = await setup();
    const p = await s.say({ userId: s.alice.userId });
    const r = await s.say({ userId: s.bob.userId, parentId: p.id });
    expect(await deleteMessage(env.DB, { messageId: p.id, userId: s.carol.userId, now: 9_000 })).toEqual({ ok: false, code: 'forbidden' });
    // The reply's own author may not delete the starter either.
    expect(await deleteMessage(env.DB, { messageId: p.id, userId: s.bob.userId, now: 9_000 })).toEqual({ ok: false, code: 'forbidden' });
    expect(await row(p.id)).toMatchObject({ deletedAt: null, replyCount: 1 });
    expect((await row(r.id))!.deletedAt).toBeNull();
    await env.DB.prepare("UPDATE workspace_members SET role = 'admin' WHERE user_id = ?").bind(s.carol.userId).run();
    const d = await deleteMessage(env.DB, { messageId: p.id, userId: s.carol.userId, now: 9_001 });
    if (!d.ok) throw new Error(d.code);
    expect(d.replies.map((m) => m.id)).toEqual([r.id]);
    expect((await row(r.id))!.deletedAt).toBe(9_001);
  });

  it('a starter without replies cascades nothing', async () => {
    const s = await setup();
    const p = await s.say({ userId: s.alice.userId });
    const d = await deleteMessage(env.DB, { messageId: p.id, userId: s.alice.userId, now: 9_000 });
    if (!d.ok) throw new Error(d.code);
    expect(d.replies).toEqual([]);
    expect(d.repliesTotal).toBe(0);
    expect(d.parent).toBeNull();
  });

  it('returns at most 500 reply tombstones but still deletes every reply', async () => {
    const s = await setup();
    const p = await s.say({ userId: s.alice.userId });
    const stmts = [];
    for (let i = 0; i < 503; i++) {
      stmts.push(
        env.DB.prepare(
          'INSERT INTO messages (id, channel_id, seq, user_id, parent_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).bind(`R${String(i).padStart(4, '0')}`, GENERAL, 100 + i, s.bob.userId, p.id, 'x', 2_000 + i),
      );
    }
    stmts.push(env.DB.prepare('UPDATE messages SET reply_count = 503 WHERE id = ?').bind(p.id));
    await env.DB.batch(stmts);
    const d = await deleteMessage(env.DB, { messageId: p.id, userId: s.alice.userId, now: 9_000 });
    if (!d.ok) throw new Error(d.code);
    expect(d.replies).toHaveLength(500);
    expect(d.replies[0]!.id).toBe('R0000');
    expect(d.repliesTotal).toBe(503);
    const live = await env.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE parent_id = ? AND deleted_at IS NULL')
      .bind(p.id)
      .first<{ n: number }>();
    expect(live!.n).toBe(0);
  });

  it('catchup for a client that missed everything returns the tombstones with zeroed counters', async () => {
    const s = await setup();
    const p = await s.say({ userId: s.alice.userId });
    const r1 = await s.say({ userId: s.bob.userId, parentId: p.id });
    const r2 = await s.say({ userId: s.carol.userId, parentId: p.id });
    await deleteMessage(env.DB, { messageId: p.id, userId: s.alice.userId, now: 9_000 });
    const cu = await catchUp(env.DB, [GENERAL], { [GENERAL]: 0 });
    const by = new Map(cu.messages.map((m) => [m.id, m]));
    expect(by.get(p.id)).toMatchObject({ deletedAt: 9_000, body: '', replyCount: 0, lastReplyAt: null });
    for (const r of [r1, r2]) expect(by.get(r.id)).toMatchObject({ deletedAt: 9_000, body: '', parentId: p.id });
  });
});

describe('hub frames for deletes', () => {
  async function connectAll(s: Awaited<ReturnType<typeof setup>>) {
    return {
      alice: await connect(s.app, s.alice.cookie),
      bob: await connect(s.app, s.bob.cookie),
      carol: await connect(s.app, s.carol.cookie),
    };
  }

  it('a reply delete broadcasts message.delete then thread.counts to every channel member', async () => {
    const s = await setup();
    const p = await s.say({ userId: s.alice.userId });
    const r1 = await s.say({ userId: s.bob.userId, parentId: p.id });
    const r2 = await s.say({ userId: s.bob.userId, parentId: p.id });
    const { alice, bob, carol } = await connectAll(s);
    bob.send({ t: 'delete', messageId: r2.id });
    for (const sock of [alice, bob, carol]) {
      const d = await sock.next('message.delete');
      expect(d.message).toMatchObject({ id: r2.id, parentId: p.id, body: '' });
      const c = await sock.next('thread.counts');
      expect(c).toEqual({ t: 'thread.counts', channelId: GENERAL, parentId: p.id, replyCount: 1, lastReplyAt: r1.createdAt });
      const order = sock.frames.map((f) => f.t).filter((t) => t === 'message.delete' || t === 'thread.counts');
      expect(order).toEqual(['message.delete', 'thread.counts']);
    }
  });

  it('a starter delete broadcasts one message.delete for the starter and one per cascaded reply, and no counts frame', async () => {
    const s = await setup();
    const p = await s.say({ userId: s.alice.userId });
    const r1 = await s.say({ userId: s.bob.userId, parentId: p.id });
    const r2 = await s.say({ userId: s.carol.userId, parentId: p.id });
    const { alice, bob } = await connectAll(s);
    alice.send({ t: 'delete', messageId: p.id });
    for (const sock of [alice, bob]) {
      const ids = [
        (await sock.next('message.delete')).message.id,
        (await sock.next('message.delete')).message.id,
        (await sock.next('message.delete')).message.id,
      ];
      expect(ids).toEqual([p.id, r1.id, r2.id]);
      await sock.none('message.delete', 100);
      await sock.none('thread.counts', 100);
    }
  });

  it('a refused cascade (third user) broadcasts nothing and nacks', async () => {
    const s = await setup();
    const p = await s.say({ userId: s.alice.userId });
    await s.say({ userId: s.bob.userId, parentId: p.id });
    const { bob, carol } = await connectAll(s);
    carol.send({ t: 'delete', messageId: p.id, clientId: 'cas-1-xxxxxx' });
    expect((await carol.next('nack')).code).toBe('forbidden');
    await bob.none('message.delete', 100);
  });
});

describe('search after a cascade', () => {
  async function hits(s: Awaited<ReturnType<typeof setup>>, word: string): Promise<string[]> {
    const ctx = createExecutionContext();
    const res = await s.app.request(`/w/clubhack/search?q=${word}`, { headers: { Cookie: s.carol.cookie } }, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    return ((await res.json()) as { results: { message: { id: string } }[] }).results.map((r) => r.message.id);
  }

  it('finds neither the starter nor a cascaded reply by a unique word, and still finds a survivor', async () => {
    const s = await setup();
    const p = await s.say({ userId: s.alice.userId, body: 'quokkaword starter' });
    const r = await s.say({ userId: s.bob.userId, parentId: p.id, body: 'reply with quokkaword too' });
    const solo = await s.say({ userId: s.alice.userId, body: 'quokkaword survivor' });
    expect((await hits(s, 'quokkaword')).sort()).toEqual([p.id, r.id, solo.id].sort());
    const d = await deleteMessage(env.DB, { messageId: p.id, userId: s.alice.userId, now: 9_000 });
    expect(d.ok).toBe(true);
    expect(await hits(s, 'quokkaword')).toEqual([solo.id]);
  });
});

describe("an admin or owner deleting another user's reply", () => {
  it('a plain member is refused; an admin and the owner may delete it, counters recomputed and frames sent', async () => {
    const s = await setup();
    const p = await s.say({ userId: s.alice.userId });
    const r1 = await s.say({ userId: s.bob.userId, parentId: p.id });
    const r2 = await s.say({ userId: s.bob.userId, parentId: p.id });
    const r3 = await s.say({ userId: s.bob.userId, parentId: p.id });
    // carol is a plain member; the starter's author (alice) is also just a member.
    expect(await deleteMessage(env.DB, { messageId: r1.id, userId: s.carol.userId, now: 9_000 })).toEqual({ ok: false, code: 'forbidden' });
    expect(await deleteMessage(env.DB, { messageId: r1.id, userId: s.alice.userId, now: 9_000 })).toEqual({ ok: false, code: 'forbidden' });
    expect(await row(p.id)).toMatchObject({ replyCount: 3 });
    expect((await row(r1.id))!.deletedAt).toBeNull();

    await env.DB.prepare("UPDATE workspace_members SET role = 'admin' WHERE user_id = ?").bind(s.carol.userId).run();
    const da = await deleteMessage(env.DB, { messageId: r3.id, userId: s.carol.userId, now: 9_001 });
    if (!da.ok) throw new Error(da.code);
    expect(da.replies).toEqual([]);
    expect(da.parent).toEqual({ id: p.id, channelId: GENERAL, replyCount: 2, lastReplyAt: r2.createdAt });
    const dow = await deleteMessage(env.DB, { messageId: r2.id, userId: s.owner.userId, now: 9_002 });
    if (!dow.ok) throw new Error(dow.code);
    expect(dow.parent).toEqual({ id: p.id, channelId: GENERAL, replyCount: 1, lastReplyAt: r1.createdAt });
    expect(await row(p.id)).toMatchObject({ replyCount: 1, lastReplyAt: r1.createdAt, deletedAt: null });
  });

  it("over the socket an admin's delete of another user's reply sends message.delete then thread.counts; a member's is nacked", async () => {
    const s = await setup();
    const p = await s.say({ userId: s.alice.userId });
    const r1 = await s.say({ userId: s.bob.userId, parentId: p.id });
    const r2 = await s.say({ userId: s.bob.userId, parentId: p.id });
    await env.DB.prepare("UPDATE workspace_members SET role = 'admin' WHERE user_id = ?").bind(s.carol.userId).run();
    const alice = await connect(s.app, s.alice.cookie);
    const bob = await connect(s.app, s.bob.cookie);
    const carol = await connect(s.app, s.carol.cookie);
    alice.send({ t: 'delete', messageId: r1.id, clientId: 'mem-1-xxxxxx' });
    expect((await alice.next('nack')).code).toBe('forbidden');
    await bob.none('message.delete', 100);
    carol.send({ t: 'delete', messageId: r2.id });
    for (const sock of [alice, bob, carol]) {
      expect((await sock.next('message.delete')).message).toMatchObject({ id: r2.id, parentId: p.id, body: '' });
      expect(await sock.next('thread.counts')).toEqual({
        t: 'thread.counts', channelId: GENERAL, parentId: p.id, replyCount: 1, lastReplyAt: r1.createdAt,
      });
    }
  });
});
