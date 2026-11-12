import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { Bootstrap, Me } from '@backroom/protocol';
import { sendMessage } from '../src/messaging/store';
import { GENERAL, captureMailer, resetDb, seedUsers, send, signIn, testDeps } from './helpers';

async function setup() {
  const { mailer, sent } = captureMailer();
  const app = createApp(testDeps({ mailer }));
  const cookie = await signIn(app, sent, 'owner@test.dev');
  const me = (await (await send(app, 'GET', '/me', undefined, cookie)).json()) as Me;
  return { app, sent, cookie, userId: me.id };
}

async function addMessage(id: string, seq: number, userId: string, opts: { parent?: string; also?: number; deleted?: boolean } = {}) {
  await env.DB.prepare(
    'INSERT INTO messages (id, channel_id, seq, user_id, parent_id, body, also_in_channel, created_at, deleted_at) VALUES (?,?,?,?,?,?,?,?,?)',
  )
    .bind(id, GENERAL, seq, userId, opts.parent ?? null, 'x', opts.also ?? 0, 1, opts.deleted ? 2 : null)
    .run();
  await env.DB.prepare('UPDATE channels SET last_seq = MAX(last_seq, ?) WHERE id = ?').bind(seq, GENERAL).run();
}

beforeEach(resetDb);

describe('bootstrap', () => {
  it('bootstrap lists general only after first login, with zero counts', async () => {
    const { app, cookie } = await setup();
    const res = await send(app, 'GET', '/w/clubhack/bootstrap', undefined, cookie);
    expect(res.status).toBe(200);
    const b = (await res.json()) as Bootstrap;
    expect(b.workspace.slug).toBe('clubhack');
    expect(b.me.email).toBe('owner@test.dev');
    expect(b.me.role).toBe('owner');
    expect(b.channels).toHaveLength(1);
    expect(b.channels[0]).toMatchObject({ id: GENERAL, name: 'general', kind: 'public', unreadCount: 0, mentionCount: 0 });
    expect(b.members.map((m) => m.id)).toEqual([b.me.id]);
  });

  it('channels carry createdBy and dmUserIds (null unless dm)', async () => {
    const { app, cookie, userId } = await setup();
    const first = (await (await send(app, 'GET', '/w/clubhack/bootstrap', undefined, cookie)).json()) as Bootstrap;
    expect(first.channels[0]!.dmUserIds).toBeNull();
    expect(first.channels[0]).toHaveProperty('createdBy');
    const seeded = await env.DB.prepare('SELECT created_by AS c FROM channels WHERE id = ?').bind(GENERAL).first<{ c: string | null }>();
    expect(first.channels[0]!.createdBy).toBe(seeded!.c);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO channels (id, workspace_id, name, kind, dm_key, created_by, created_at) VALUES ('01JDMTEST000000000000000AB', (SELECT workspace_id FROM channels WHERE id = ?), NULL, 'dm', 'A,B', ?, 1)",
      ).bind(GENERAL, userId),
      env.DB.prepare("INSERT INTO channel_members (channel_id, user_id, joined_at) VALUES ('01JDMTEST000000000000000AB', ?, 1)").bind(userId),
    ]);
    const b = (await (await send(app, 'GET', '/w/clubhack/bootstrap', undefined, cookie)).json()) as Bootstrap;
    const dm = b.channels.find((c) => c.kind === 'dm')!;
    expect(dm.dmUserIds).toEqual(['A', 'B']);
    expect(dm.createdBy).toBe(userId);
  });

  it('unread excludes thread replies unless also_in_channel', async () => {
    const { app, cookie, userId } = await setup();
    await addMessage('m1', 1, userId);
    await addMessage('m2', 2, userId, { parent: 'm1' });
    await addMessage('m3', 3, userId, { parent: 'm1', also: 1 });
    await addMessage('m4', 4, userId, { deleted: true });
    const b = (await (await send(app, 'GET', '/w/clubhack/bootstrap', undefined, cookie)).json()) as Bootstrap;
    expect(b.channels[0]!.unreadCount).toBe(2);
    expect(b.channels[0]!.lastSeq).toBe(4);
  });

  it('mentionCount counts direct and @channel mentions', async () => {
    const { app, cookie, userId } = await setup();
    await env.DB.prepare('UPDATE channel_members SET last_read_seq = 1 WHERE user_id = ?').bind(userId).run();
    await addMessage('m1', 1, userId); // already read
    await addMessage('m2', 2, userId);
    await addMessage('m3', 3, 'u-other'); // the @channel row, authored by someone else
    await env.DB.batch([
      env.DB.prepare("INSERT INTO mentions (message_id, user_id, kind) VALUES ('m1', ?, 'user')").bind(userId),
      env.DB.prepare("INSERT INTO mentions (message_id, user_id, kind) VALUES ('m2', ?, 'user')").bind(userId),
      env.DB.prepare("INSERT INTO mentions (message_id, user_id, kind) VALUES ('m3', NULL, 'channel')"),
    ]);
    const b = (await (await send(app, 'GET', '/w/clubhack/bootstrap', undefined, cookie)).json()) as Bootstrap;
    expect(b.channels[0]!.mentionCount).toBe(2);
    expect(b.channels[0]!.unreadCount).toBe(2);
  });

  it('own @channel does not count toward own mentionCount', async () => {
    const { mailer, sent } = captureMailer();
    const app = createApp(testDeps({ mailer }));
    const [owner, alice] = await seedUsers(app, sent, ['owner@test.dev', 'alice@test.dev']);
    const r = await sendMessage(env.DB, {
      clientId: crypto.randomUUID(), channelId: GENERAL, userId: owner!.userId, parentId: null,
      body: '@channel hi', alsoInChannel: false, fileIds: [], now: 1_000,
    });
    expect(r.ok).toBe(true);
    // Posting marks the channel read for the author; reset it so only the predicate decides.
    await env.DB.prepare('UPDATE channel_members SET last_read_seq = 0 WHERE user_id = ?').bind(owner!.userId).run();
    const count = async (cookie: string) =>
      ((await (await send(app, 'GET', '/w/clubhack/bootstrap', undefined, cookie)).json()) as Bootstrap).channels[0]!.mentionCount;
    expect(await count(owner!.cookie)).toBe(0);
    expect(await count(alice!.cookie)).toBe(1);
  });

  it('non-member gets identical 404 for clubhack and for an unknown slug', async () => {
    const { app, sent } = await setup();
    // A signed-in user who is no longer an active member (membership removed after sign-in).
    const ownerCookie = await signIn(app, sent, 'owner@test.dev');
    // Sessions need some active membership, so move the user into another workspace.
    await env.DB.batch([
      env.DB.prepare("INSERT INTO workspaces (id, slug, name, created_at) VALUES ('w-other', 'other', 'Other', 1)"),
      env.DB.prepare("UPDATE workspace_members SET workspace_id = 'w-other'"),
    ]);
    const a = await send(app, 'GET', '/w/clubhack/bootstrap', undefined, ownerCookie);
    const b = await send(app, 'GET', '/w/nope/bootstrap', undefined, ownerCookie);
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    expect(await a.json()).toEqual(await b.json());
    expect(((await send(app, 'GET', '/w/nope/bootstrap', undefined, ownerCookie).then((r) => r.json())) as any).error.code).toBe('not_found');
    await env.DB.prepare("DELETE FROM workspaces WHERE id = 'w-other'").run();
  });

  it('PATCH /me trims and updates display name; empty name is 400 invalid_request', async () => {
    const { app, cookie } = await setup();
    const ok = await send(app, 'PATCH', '/me', { displayName: '  Ada  ' }, cookie);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as Me).displayName).toBe('Ada');
    expect(((await (await send(app, 'GET', '/me', undefined, cookie)).json()) as Me).displayName).toBe('Ada');
    const bad = await send(app, 'PATCH', '/me', { displayName: '   ' }, cookie);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error.code).toBe('invalid_request');
  });

  it('bootstrap without session is 401', async () => {
    const { app } = await setup();
    expect((await send(app, 'GET', '/w/clubhack/bootstrap')).status).toBe(401);
    expect((await send(app, 'GET', '/me')).status).toBe(401);
  });
});
