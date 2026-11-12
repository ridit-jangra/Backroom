import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { loadReactions, toggleReaction } from '../src/emoji/reactions';
import { sendMessage } from '../src/messaging/store';
import { GENERAL, captureMailer, insertChannel, insertCustomEmoji, resetDb, seedUsers, testDeps } from './helpers';

beforeEach(resetDb);

async function setup() {
  const { mailer, sent } = captureMailer();
  const app = createApp(testDeps({ mailer }));
  const [owner, alice, bob] = await seedUsers(app, sent, ['owner@test.dev', 'alice@test.dev', 'bob@test.dev']);
  const say = async (channelId = GENERAL, userId = alice!.userId) => {
    const r = await sendMessage(env.DB, {
      clientId: crypto.randomUUID(), channelId, userId, parentId: null, body: 'hi', alsoInChannel: false, fileIds: [], now: 1,
    });
    if (!r.ok) throw new Error(r.code);
    return r.message.id;
  };
  const m = await say();
  const t = (o: Partial<Parameters<typeof toggleReaction>[1]> = {}) =>
    toggleReaction(env.DB, { messageId: m, userId: alice!.userId, emoji: '+1', on: true, now: 1, ...o });
  return { owner: owner!, alice: alice!, bob: bob!, m, t, say };
}

const rows = async (m: string) =>
  (await env.DB.prepare('SELECT user_id, emoji FROM reactions WHERE message_id = ?').bind(m).all()).results;

describe('toggleReaction', () => {
  it('on writes one row; repeating is changed:false; off deletes; off again is changed:false', async () => {
    const { t, m } = await setup();
    expect(await t()).toMatchObject({ ok: true, emoji: '+1', changed: true });
    expect(await t()).toMatchObject({ ok: true, changed: false });
    expect(await rows(m)).toHaveLength(1);
    expect(await t({ on: false })).toMatchObject({ ok: true, changed: true });
    expect(await rows(m)).toHaveLength(0);
    expect(await t({ on: false })).toMatchObject({ ok: true, changed: false });
  });

  it('aliases and tones canonicalize', async () => {
    const { t } = await setup();
    expect(await t({ emoji: 'thumbsup' })).toMatchObject({ ok: true, emoji: '+1' });
    expect(await t({ emoji: 'wave::skin-tone-3' })).toMatchObject({ ok: true, emoji: 'wave::skin-tone-3' });
    expect(await t({ emoji: 'heart::skin-tone-3' })).toEqual({ ok: false, code: 'invalid' });
    expect(await t({ emoji: 'nosuchemoji' })).toEqual({ ok: false, code: 'invalid' });
  });

  it('custom emoji and custom aliases', async () => {
    const { t } = await setup();
    await insertCustomEmoji({ name: 'partyparrot' });
    await insertCustomEmoji({ name: 'pp', aliasFor: 'partyparrot' });
    await insertCustomEmoji({ name: 'yay', aliasFor: 'tada' });
    await insertCustomEmoji({ name: 'other', workspaceId: 'otherworkspace0000000000000' });
    expect(await t({ emoji: 'partyparrot' })).toMatchObject({ ok: true, emoji: 'partyparrot' });
    expect(await t({ emoji: 'pp' })).toMatchObject({ ok: true, emoji: 'partyparrot', changed: false });
    expect(await t({ emoji: 'yay' })).toMatchObject({ ok: true, emoji: 'tada' });
    expect(await t({ emoji: 'other' })).toEqual({ ok: false, code: 'invalid' });
  });

  it('off works for a deleted custom emoji', async () => {
    const { t } = await setup();
    await insertCustomEmoji({ name: 'partyparrot' });
    await t({ emoji: 'partyparrot' });
    await env.DB.prepare("DELETE FROM custom_emoji WHERE name = 'partyparrot'").run();
    expect(await t({ emoji: 'partyparrot', on: false })).toMatchObject({ ok: true, changed: true });
  });

  it('visibility', async () => {
    const { t, say, alice, bob, m } = await setup();
    const priv = await insertChannel({ name: 'secret', kind: 'private', memberIds: [bob.userId] });
    const pm = await say(priv, bob.userId);
    expect(await t({ messageId: pm })).toEqual({ ok: false, code: 'not_found' });
    expect(await t({ messageId: '01JZZZZZZZZZZZZZZZZZZZZZZZ' })).toEqual({ ok: false, code: 'not_found' });
    await env.DB.prepare('UPDATE messages SET deleted_at = 5 WHERE id = ?').bind(m).run();
    expect(await t()).toEqual({ ok: false, code: 'not_found' });
    const pub = await insertChannel({ name: 'pub', kind: 'public', memberIds: [bob.userId] });
    const xm = await say(pub, bob.userId);
    expect(await t({ messageId: xm })).toEqual({ ok: false, code: 'not_found' });
    const arch = await insertChannel({ name: 'arch', kind: 'public', memberIds: [alice.userId] });
    const am = await say(arch);
    await env.DB.prepare('UPDATE channels SET archived_at = 9 WHERE id = ?').bind(arch).run();
    expect(await t({ messageId: am })).toEqual({ ok: false, code: 'archived' });
  });

  it('51st distinct emoji is invalid; an existing emoji is still accepted at the cap', async () => {
    const { t, m, bob, owner } = await setup();
    const stmts = Array.from({ length: 50 }, (_, i) =>
      env.DB.prepare('INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, 1)').bind(
        m, i % 2 ? bob.userId : owner.userId, i === 0 ? 'tada' : `custom${i}`,
      ),
    );
    await env.DB.batch(stmts);
    expect(await t({ emoji: '+1' })).toEqual({ ok: false, code: 'invalid' });
    expect(await t({ emoji: 'tada' })).toMatchObject({ ok: true, emoji: 'tada', changed: true });
    expect(await t({ emoji: 'tada' })).toMatchObject({ ok: true, changed: false });
  });
});

describe('loadReactions', () => {
  it('groups by emoji in first-reaction order', async () => {
    const { m, alice, bob, owner } = await setup();
    const ins = (u: string, e: string, at: number) =>
      env.DB.prepare('INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)').bind(m, u, e, at);
    await env.DB.batch([ins(owner.userId, 'tada', 3), ins(alice.userId, '+1', 2), ins(bob.userId, 'tada', 1)]);
    const expected = [
      { emoji: 'tada', userIds: [bob.userId, owner.userId] },
      { emoji: '+1', userIds: [alice.userId] },
    ];
    expect((await loadReactions(env.DB, [m])).get(m)).toEqual(expected);
    const many = [m, ...Array.from({ length: 149 }, (_, i) => `01JMISSING${String(i).padStart(16, '0')}`)];
    expect((await loadReactions(env.DB, many)).get(m)).toEqual(expected);
    expect((await loadReactions(env.DB, [])).size).toBe(0);
  });
});
