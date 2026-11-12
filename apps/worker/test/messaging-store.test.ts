import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { deleteMessage, editMessage, sendMessage, type SendInput } from '../src/messaging/store';
import { GENERAL, captureMailer, insertChannel, resetDb, seedUsers, testDeps } from './helpers';

beforeEach(resetDb);

async function setup() {
  const { mailer, sent } = captureMailer();
  const app = createApp(testDeps({ mailer }));
  const [owner, alice, bob] = await seedUsers(app, sent, ['owner@test.dev', 'alice@test.dev', 'bob@test.dev']);
  const input = (o: Partial<SendInput>): SendInput => ({
    clientId: crypto.randomUUID(),
    channelId: GENERAL,
    userId: alice!.userId,
    parentId: null,
    body: 'hi',
    alsoInChannel: false,
    fileIds: [],
    now: 1_000,
    ...o,
  });
  return { owner: owner!.userId, alice: alice!.userId, bob: bob!.userId, input };
}

const lastSeq = async (id = GENERAL) =>
  (await env.DB.prepare('SELECT last_seq AS s FROM channels WHERE id = ?').bind(id).first<{ s: number }>())!.s;

describe('sendMessage', () => {
  it('assigns consecutive seqs and bumps last_seq', async () => {
    const { input } = await setup();
    const seqs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await sendMessage(env.DB, input({}));
      if (!r.ok) throw new Error(r.code);
      seqs.push(r.message.seq);
    }
    expect(seqs).toEqual([1, 2, 3]);
    expect(await lastSeq()).toBe(3);
  });

  it('failed batch consumes no seq', async () => {
    const { input, alice } = await setup();
    await env.DB.prepare(
      "INSERT INTO messages (id, channel_id, seq, user_id, body, created_at) VALUES ('raw', ?, 1, ?, 'x', 1)",
    ).bind(GENERAL, alice).run();
    expect(await sendMessage(env.DB, input({}))).toEqual({ ok: false, code: 'failed' });
    expect(await lastSeq()).toBe(0);
    await env.DB.prepare("DELETE FROM messages WHERE id = 'raw'").run();
    const r = await sendMessage(env.DB, input({}));
    expect(r.ok && r.message.seq).toBe(1);
  });

  it('same clientId twice returns the original message', async () => {
    const { input } = await setup();
    const i = input({});
    const a = await sendMessage(env.DB, i);
    const b = await sendMessage(env.DB, i);
    if (!a.ok || !b.ok) throw new Error('expected ok');
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(true);
    expect(b.message.id).toBe(a.message.id);
    expect((await env.DB.prepare('SELECT count(*) AS n FROM messages').first<{ n: number }>())!.n).toBe(1);
  });

  it('non-member and missing channel both give not_found', async () => {
    const { input, bob } = await setup();
    const priv = await insertChannel({ name: 'secret', kind: 'private', memberIds: [bob] });
    expect(await sendMessage(env.DB, input({ channelId: priv }))).toEqual({ ok: false, code: 'not_found' });
    expect(await sendMessage(env.DB, input({ channelId: '01JNOSUCHCHANNEL0000000000' }))).toEqual({ ok: false, code: 'not_found' });
  });

  it('archived channel gives archived; fileIds gives invalid; reply to a reply gives invalid', async () => {
    const { input, alice } = await setup();
    const arch = await insertChannel({ name: 'old', kind: 'public', memberIds: [alice] });
    await env.DB.prepare('UPDATE channels SET archived_at = 5 WHERE id = ?').bind(arch).run();
    expect(await sendMessage(env.DB, input({ channelId: arch }))).toEqual({ ok: false, code: 'archived' });
    expect(await sendMessage(env.DB, input({ fileIds: ['f'] }))).toEqual({ ok: false, code: 'invalid' });
    const p = await sendMessage(env.DB, input({}));
    if (!p.ok) throw new Error('p');
    const r = await sendMessage(env.DB, input({ parentId: p.message.id }));
    if (!r.ok) throw new Error('r');
    expect(await sendMessage(env.DB, input({ parentId: r.message.id }))).toEqual({ ok: false, code: 'invalid' });
    expect(await sendMessage(env.DB, input({ parentId: '01JNOSUCHMESSAGE0000000000' }))).toEqual({ ok: false, code: 'invalid' });
  });

  it('writes mention rows for channel members only, never the author', async () => {
    const { input, alice, bob, owner } = await setup();
    // owner is a real workspace member but not in this private channel.
    const priv = await insertChannel({ name: 'pair', kind: 'private', memberIds: [alice, bob] });
    const r = await sendMessage(env.DB, input({ channelId: priv, body: `<@${bob}> <@${owner}> <@${alice}> @here` }));
    if (!r.ok) throw new Error(r.code);
    const rows = await env.DB.prepare('SELECT user_id, kind FROM mentions WHERE message_id = ? ORDER BY kind DESC').bind(r.message.id).all();
    expect(rows.results).toEqual([
      { user_id: bob, kind: 'user' },
      { user_id: null, kind: 'here' },
    ]);
    expect(r.audience.mentions.userIds).toEqual([bob]);
    expect(r.audience.mentions.here).toBe(true);
  });

  it('sender must be an active workspace member; deactivated members are excluded from audience and mentions', async () => {
    const { input, alice, bob } = await setup();
    await env.DB.prepare('UPDATE workspace_members SET deactivated_at = 5 WHERE user_id = ?').bind(bob).run();
    const r = await sendMessage(env.DB, input({ body: `<@${bob}> hi` }));
    if (!r.ok) throw new Error(r.code);
    expect(r.audience.members.map((m) => m.userId)).not.toContain(bob);
    expect(r.audience.mentions.userIds).toEqual([]);
    expect((await env.DB.prepare('SELECT count(*) AS n FROM mentions WHERE message_id = ?').bind(r.message.id).first<{ n: number }>())!.n).toBe(0);
    expect(await sendMessage(env.DB, input({ userId: bob }))).toEqual({ ok: false, code: 'not_found' });
    expect(alice).toBeTruthy();
  });

  it('resend after the channel is archived still returns the original', async () => {
    const { input } = await setup();
    const i = input({});
    const a = await sendMessage(env.DB, i);
    if (!a.ok) throw new Error('a');
    await env.DB.prepare('UPDATE channels SET archived_at = 5 WHERE id = ?').bind(GENERAL).run();
    const b = await sendMessage(env.DB, i);
    if (!b.ok) throw new Error(b.code);
    expect(b.duplicate).toBe(true);
    expect(b.message.id).toBe(a.message.id);
  });

  it('reply increments parent and follows thread', async () => {
    const { input, alice, bob } = await setup();
    const p = await sendMessage(env.DB, input({ now: 1_000 }));
    if (!p.ok) throw new Error('p');
    const r = await sendMessage(env.DB, input({ userId: bob, parentId: p.message.id, now: 2_000 }));
    if (!r.ok) throw new Error('r');
    const parent = await env.DB.prepare('SELECT reply_count AS c, last_reply_at AS l FROM messages WHERE id = ?').bind(p.message.id).first();
    expect(parent).toEqual({ c: 1, l: 2_000 });
    const f = await env.DB.prepare('SELECT user_id FROM thread_follows WHERE message_id = ? ORDER BY user_id').bind(p.message.id).all();
    expect(f.results.map((x) => x.user_id).sort()).toEqual([alice, bob].sort());
    const read = await env.DB.prepare('SELECT last_read_reply_seq AS s FROM thread_follows WHERE message_id = ? AND user_id = ?').bind(p.message.id, bob).first<{ s: number }>();
    expect(read!.s).toBe(r.message.seq);
    const bobRead = await env.DB.prepare('SELECT last_read_seq AS s FROM channel_members WHERE channel_id = ? AND user_id = ?').bind(GENERAL, bob).first<{ s: number }>();
    expect(bobRead!.s).toBe(0);
    expect(r.audience.followers).toEqual([alice]);
    expect(r.message.parentId).toBe(p.message.id);
  });

  it('own top-level post advances own last_read_seq', async () => {
    const { input, alice } = await setup();
    const r = await sendMessage(env.DB, input({}));
    if (!r.ok) throw new Error('r');
    const row = await env.DB.prepare('SELECT last_read_seq AS s FROM channel_members WHERE channel_id = ? AND user_id = ?').bind(GENERAL, alice).first<{ s: number }>();
    expect(row!.s).toBe(1);
  });
});

describe('editMessage / deleteMessage', () => {
  it('edit by non-author is forbidden; edit replaces mentions and sets editedAt', async () => {
    const { input, bob, owner } = await setup();
    const r = await sendMessage(env.DB, input({ body: `<@${bob}> hi` }));
    if (!r.ok) throw new Error('r');
    expect(await editMessage(env.DB, { messageId: r.message.id, userId: bob, body: 'x', now: 5 })).toEqual({ ok: false, code: 'forbidden' });
    const e = await editMessage(env.DB, { messageId: r.message.id, userId: r.message.userId, body: `<@${owner}> @channel`, now: 5_000 });
    if (!e.ok) throw new Error(e.code);
    expect(e.message.editedAt).toBe(5_000);
    expect(e.message.body).toBe(`<@${owner}> @channel`);
    const rows = await env.DB.prepare('SELECT user_id, kind FROM mentions WHERE message_id = ? ORDER BY kind').bind(r.message.id).all();
    expect(rows.results).toEqual([
      { user_id: null, kind: 'channel' },
      { user_id: owner, kind: 'user' },
    ]);
  });

  it('edit/delete of a message in a channel the caller cannot see is not_found, even for non-authors', async () => {
    const { input, alice, bob } = await setup();
    const priv = await insertChannel({ name: 'secret', kind: 'private', memberIds: [alice] });
    const r = await sendMessage(env.DB, input({ channelId: priv }));
    if (!r.ok) throw new Error('r');
    expect(await editMessage(env.DB, { messageId: r.message.id, userId: bob, body: 'x', now: 5 })).toEqual({ ok: false, code: 'not_found' });
    expect(await deleteMessage(env.DB, { messageId: r.message.id, userId: bob, now: 5 })).toEqual({ ok: false, code: 'not_found' });
    expect(await editMessage(env.DB, { messageId: '01JNOSUCHMESSAGE0000000000', userId: bob, body: 'x', now: 5 })).toEqual({ ok: false, code: 'not_found' });
  });

  it('delete clears body, keeps the row, removes mentions; admin may delete others; plain member may not; edit of deleted is not_found', async () => {
    const { input, alice, bob } = await setup();
    const r = await sendMessage(env.DB, input({ userId: bob, body: `<@${alice}> @here` }));
    if (!r.ok) throw new Error('r');
    expect(await deleteMessage(env.DB, { messageId: r.message.id, userId: alice, now: 9 })).toEqual({ ok: false, code: 'forbidden' });
    await env.DB.prepare("UPDATE workspace_members SET role = 'admin' WHERE user_id = ?").bind(alice).run();
    const d = await deleteMessage(env.DB, { messageId: r.message.id, userId: alice, now: 9_000 });
    if (!d.ok) throw new Error(d.code);
    expect(d.message.deletedAt).toBe(9_000);
    expect(d.message.body).toBe('');
    expect((await env.DB.prepare('SELECT count(*) AS n FROM messages WHERE id = ?').bind(r.message.id).first<{ n: number }>())!.n).toBe(1);
    expect((await env.DB.prepare('SELECT count(*) AS n FROM mentions WHERE message_id = ?').bind(r.message.id).first<{ n: number }>())!.n).toBe(0);
    expect(await editMessage(env.DB, { messageId: r.message.id, userId: bob, body: 'x', now: 10 })).toEqual({ ok: false, code: 'not_found' });
    expect(await deleteMessage(env.DB, { messageId: r.message.id, userId: alice, now: 10 })).toEqual({ ok: false, code: 'not_found' });
  });

  it('edit and delete in an archived channel give archived, like send', async () => {
    const { input, alice } = await setup();
    const ch = await insertChannel({ name: 'old', kind: 'public', memberIds: [alice] });
    const r = await sendMessage(env.DB, input({ channelId: ch }));
    if (!r.ok) throw new Error('r');
    await env.DB.prepare('UPDATE channels SET archived_at = 5 WHERE id = ?').bind(ch).run();
    expect(await editMessage(env.DB, { messageId: r.message.id, userId: alice, body: 'changed', now: 9 })).toEqual({ ok: false, code: 'archived' });
    expect(await deleteMessage(env.DB, { messageId: r.message.id, userId: alice, now: 9 })).toEqual({ ok: false, code: 'archived' });
    const row = await env.DB.prepare('SELECT body, edited_at AS e, deleted_at AS d FROM messages WHERE id = ?').bind(r.message.id).first();
    expect(row).toEqual({ body: 'hi', e: null, d: null });
  });

  it('author may delete their own message', async () => {
    const { input, alice } = await setup();
    const r = await sendMessage(env.DB, input({}));
    if (!r.ok) throw new Error('r');
    expect((await deleteMessage(env.DB, { messageId: r.message.id, userId: alice, now: 9 })).ok).toBe(true);
  });
});
