import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChannelInfo, ChannelListing, ChannelSummary } from '@backroom/protocol';
import { createApp } from '../src/app';
import { GENERAL, captureMailer, insertChannel, resetDb, seedUsers, send, testDeps } from './helpers';
import { closeAll, connect, hubStub } from './ws';

beforeEach(resetDb);
afterEach(async () => {
  await closeAll();
  await runInDurableObject(hubStub(), (hub) => {
    hub.now = () => Date.now();
  });
  await runDurableObjectAlarm(hubStub());
});

const RANDOM = '01JCLUBHACK0000000000000RD';
const UNKNOWN = '01JUNKNOWNCHANNE0000000000';

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

const json = async <T>(res: Response) => (await res.json()) as T;
const isMember = async (channelId: string, userId: string) =>
  (await env.DB.prepare('SELECT 1 AS x FROM channel_members WHERE channel_id = ? AND user_id = ?')
    .bind(channelId, userId)
    .first()) !== null;
const memberCount = async (channelId: string) =>
  (await env.DB.prepare('SELECT COUNT(*) AS n FROM channel_members WHERE channel_id = ?').bind(channelId).first<{ n: number }>())!.n;

describe('channels REST', () => {
  it('create public channel; creator is member; duplicate name is 409', async () => {
    const s = await setup();
    const res = await send(s.app, 'POST', '/w/clubhack/channels', { name: 'design', topic: 'pixels' }, s.alice.cookie);
    expect(res.status).toBe(201);
    const { channel } = await json<{ channel: ChannelSummary }>(res);
    expect(channel).toMatchObject({
      name: 'design',
      kind: 'public',
      topic: 'pixels',
      createdBy: s.alice.userId,
      dmUserIds: null,
      lastSeq: 0,
      lastReadSeq: 0,
      unreadCount: 0,
      mentionCount: 0,
    });
    expect(await memberCount(channel.id)).toBe(1);
    expect(await isMember(channel.id, s.alice.userId)).toBe(true);

    const dup = await send(s.app, 'POST', '/w/clubhack/channels', { name: 'design' }, s.bob.cookie);
    expect(dup.status).toBe(409);
    expect((await json<{ error: { code: string } }>(dup)).error.code).toBe('name_taken');

    // Archived names stay taken.
    await env.DB.prepare('UPDATE channels SET archived_at = 1 WHERE id = ?').bind(channel.id).run();
    expect((await send(s.app, 'POST', '/w/clubhack/channels', { name: 'design', private: true }, s.bob.cookie)).status).toBe(409);
  });

  it('create pushes membership.added to the creator', async () => {
    const s = await setup();
    const sock = await connect(s.app, s.alice.cookie);
    const res = await send(s.app, 'POST', '/w/clubhack/channels', { name: 'live' }, s.alice.cookie);
    const { channel } = await json<{ channel: ChannelSummary }>(res);
    const m = await sock.next('membership');
    expect(m).toMatchObject({ action: 'added', channel: { id: channel.id, name: 'live' } });
    sock.send({ t: 'send', clientId: 'c-live-000001', channelId: channel.id, body: 'hi' });
    expect((await sock.next('ack')).message.channelId).toBe(channel.id);
  });

  it('name "Has Space" is 400', async () => {
    const s = await setup();
    const res = await send(s.app, 'POST', '/w/clubhack/channels', { name: 'Has Space' }, s.alice.cookie);
    expect(res.status).toBe(400);
  });

  it('"  Design " is stored as "design"', async () => {
    const s = await setup();
    const res = await send(s.app, 'POST', '/w/clubhack/channels', { name: '  Design ' }, s.alice.cookie);
    expect(res.status).toBe(201);
    const { channel } = await json<{ channel: ChannelSummary }>(res);
    const row = await env.DB.prepare('SELECT name FROM channels WHERE id = ?').bind(channel.id).first<{ name: string }>();
    expect(row!.name).toBe('design');
  });

  it('browse lists public channels with isMember and hides others\' private channels', async () => {
    const s = await setup();
    await send(s.app, 'POST', '/w/clubhack/channels', { name: 'secret', private: true }, s.owner.cookie);
    await send(s.app, 'POST', '/w/clubhack/channels', { name: 'mine', private: true }, s.alice.cookie);
    await send(s.app, 'POST', '/w/clubhack/channels', { name: 'alpha' }, s.bob.cookie);
    const old = await insertChannel({ name: 'old', kind: 'public', memberIds: [] });
    await env.DB.prepare('UPDATE channels SET archived_at = 1 WHERE id = ?').bind(old).run();
    await insertChannel({ name: null, kind: 'dm', memberIds: [s.alice.userId, s.bob.userId], dmKey: 'x,y' });

    const res = await send(s.app, 'GET', '/w/clubhack/channels', undefined, s.alice.cookie);
    expect(res.status).toBe(200);
    const { channels } = await json<{ channels: ChannelListing[] }>(res);
    expect(channels.map((c) => c.name)).toEqual(['alpha', 'general', 'mine', 'random']);
    const by = Object.fromEntries(channels.map((c) => [c.name, c]));
    expect(by.general).toMatchObject({ id: GENERAL, isMember: true, memberCount: 4, kind: 'public', archivedAt: null });
    expect(by.random).toMatchObject({ isMember: false, memberCount: 0 });
    expect(by.alpha).toMatchObject({ isMember: false, memberCount: 1 });
    expect(by.mine).toMatchObject({ isMember: true, kind: 'private' });

    expect((await send(s.app, 'GET', '/w/otherspace/channels', undefined, s.alice.cookie)).status).toBe(404);
  });

  it("join public adds member and pushes membership.added to the joiner's socket", async () => {
    const s = await setup();
    const bob = await connect(s.app, s.bob.cookie);
    const res = await send(s.app, 'POST', `/channels/${RANDOM}/join`, undefined, s.bob.cookie);
    expect(res.status).toBe(200);
    const { channel } = await json<{ channel: ChannelSummary }>(res);
    expect(channel).toMatchObject({ id: RANDOM, name: 'random', unreadCount: 0 });
    expect(await isMember(RANDOM, s.bob.userId)).toBe(true);
    const m = await bob.next('membership');
    expect(m).toMatchObject({ action: 'added', channel: { id: RANDOM } });

    // Idempotent: a second join is fine and pushes nothing.
    expect((await send(s.app, 'POST', `/channels/${RANDOM}/join`, undefined, s.bob.cookie)).status).toBe(200);
    await bob.none('membership', 150);

    // The socket now carries the channel: sends are accepted.
    bob.send({ t: 'send', clientId: 'c-join-000001', channelId: RANDOM, body: 'hi' });
    expect((await bob.next('ack')).message.channelId).toBe(RANDOM);
  });

  it('join sets last_read_seq to last_seq', async () => {
    const s = await setup();
    await env.DB.prepare('UPDATE channels SET last_seq = 7 WHERE id = ?').bind(RANDOM).run();
    const res = await send(s.app, 'POST', `/channels/${RANDOM}/join`, undefined, s.bob.cookie);
    expect((await json<{ channel: ChannelSummary }>(res)).channel).toMatchObject({ lastSeq: 7, lastReadSeq: 7 });
    const row = await env.DB.prepare('SELECT last_read_seq AS v FROM channel_members WHERE channel_id = ? AND user_id = ?')
      .bind(RANDOM, s.bob.userId)
      .first<{ v: number }>();
    expect(row!.v).toBe(7);
  });

  it('join private is 404, same body as an unknown ID', async () => {
    const s = await setup();
    const p = await insertChannel({ name: 'priv', kind: 'private', memberIds: [s.alice.userId] });
    const a = await send(s.app, 'POST', `/channels/${p}/join`, undefined, s.bob.cookie);
    const b = await send(s.app, 'POST', `/channels/${UNKNOWN}/join`, undefined, s.bob.cookie);
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    expect(await a.text()).toBe(await b.text());
    expect(await isMember(p, s.bob.userId)).toBe(false);

    // Archived public channels cannot be joined either.
    const arch = await insertChannel({ name: 'arch', kind: 'public', memberIds: [] });
    await env.DB.prepare('UPDATE channels SET archived_at = 1 WHERE id = ?').bind(arch).run();
    expect((await send(s.app, 'POST', `/channels/${arch}/join`, undefined, s.bob.cookie)).status).toBe(404);
  });

  it('after leaving a private channel the socket receives nothing from it', async () => {
    const s = await setup();
    const p = await insertChannel({ name: 'p', kind: 'private', memberIds: [s.alice.userId, s.bob.userId] });
    const alice = await connect(s.app, s.alice.cookie);
    const bob = await connect(s.app, s.bob.cookie);

    const res = await send(s.app, 'POST', `/channels/${p}/leave`, undefined, s.bob.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await bob.next('membership')).toEqual({ t: 'membership', action: 'removed', channelId: p });
    await alice.none('membership', 50);

    alice.send({ t: 'send', clientId: 'c-left-000001', channelId: p, body: 'secret' });
    await alice.next('ack');
    alice.send({ t: 'typing', channelId: p });
    await bob.none('message.new', 200);
    await bob.none('typing', 200);

    bob.send({ t: 'send', clientId: 'c-left-000002', channelId: p, body: 'still here?' });
    expect(await bob.next('nack')).toEqual({ t: 'nack', clientId: 'c-left-000002', code: 'not_found' });
    expect(await isMember(p, s.bob.userId)).toBe(false);
  });

  it('cannot leave general or a DM (403 cannot_leave)', async () => {
    const s = await setup();
    const g = await send(s.app, 'POST', `/channels/${GENERAL}/leave`, undefined, s.alice.cookie);
    expect(g.status).toBe(403);
    expect((await json<{ error: { code: string } }>(g)).error.code).toBe('cannot_leave');
    const dm = await json<{ channel: ChannelSummary }>(
      await send(s.app, 'POST', '/w/clubhack/dms', { userIds: [s.bob.userId] }, s.alice.cookie),
    );
    const d = await send(s.app, 'POST', `/channels/${dm.channel.id}/leave`, undefined, s.alice.cookie);
    expect(d.status).toBe(403);
    expect((await json<{ error: { code: string } }>(d)).error.code).toBe('cannot_leave');
    expect(await isMember(GENERAL, s.alice.userId)).toBe(true);
    expect(await isMember(dm.channel.id, s.alice.userId)).toBe(true);
  });

  it('PATCH topic by any member; rename by plain member is 403; archive by creator broadcasts channel.update with archivedAt; general cannot be archived', async () => {
    const s = await setup();
    const created = await json<{ channel: ChannelSummary }>(
      await send(s.app, 'POST', '/w/clubhack/channels', { name: 'proj' }, s.alice.cookie),
    );
    const id = created.channel.id;
    await send(s.app, 'POST', `/channels/${id}/join`, undefined, s.bob.cookie);
    const bob = await connect(s.app, s.bob.cookie);

    const t = await send(s.app, 'PATCH', `/channels/${id}`, { topic: ' hello ' }, s.bob.cookie);
    expect(t.status).toBe(200);
    expect((await json<{ channel: ChannelInfo }>(t)).channel).toEqual({
      id,
      name: 'proj',
      kind: 'public',
      topic: 'hello',
      archivedAt: null,
    });
    expect((await bob.next('channel.update')).channel.topic).toBe('hello');

    const cleared = await send(s.app, 'PATCH', `/channels/${id}`, { topic: '' }, s.bob.cookie);
    expect((await json<{ channel: ChannelInfo }>(cleared)).channel.topic).toBeNull();
    await bob.next('channel.update');

    const rename = await send(s.app, 'PATCH', `/channels/${id}`, { name: 'bobs' }, s.bob.cookie);
    expect(rename.status).toBe(403);
    expect((await json<{ error: { code: string } }>(rename)).error.code).toBe('forbidden');
    expect((await send(s.app, 'PATCH', `/channels/${id}`, { archived: true }, s.bob.cookie)).status).toBe(403);

    // Non-member of a public channel: 403 not_member; of a private channel: 404.
    const nm = await send(s.app, 'PATCH', `/channels/${id}`, { topic: 'x' }, s.carol.cookie);
    expect(nm.status).toBe(403);
    expect((await json<{ error: { code: string } }>(nm)).error.code).toBe('not_member');
    const priv = await insertChannel({ name: 'hidden', kind: 'private', memberIds: [s.alice.userId] });
    expect((await send(s.app, 'PATCH', `/channels/${priv}`, { topic: 'x' }, s.carol.cookie)).status).toBe(404);

    // Rename by the creator; a taken name is 409.
    const ren = await send(s.app, 'PATCH', `/channels/${id}`, { name: 'Project' }, s.alice.cookie);
    expect((await json<{ channel: ChannelInfo }>(ren)).channel.name).toBe('project');
    await bob.next('channel.update');
    const taken = await send(s.app, 'PATCH', `/channels/${id}`, { name: 'random' }, s.alice.cookie);
    expect(taken.status).toBe(409);
    expect((await json<{ error: { code: string } }>(taken)).error.code).toBe('name_taken');

    const arch = await send(s.app, 'PATCH', `/channels/${id}`, { archived: true }, s.alice.cookie);
    expect(arch.status).toBe(200);
    const upd = await bob.next('channel.update');
    expect(upd.channel.id).toBe(id);
    expect(typeof upd.channel.archivedAt).toBe('number');

    // Unarchive by a workspace admin (owner) who is a member.
    await env.DB.prepare('INSERT INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, 1)').bind(id, s.owner.userId).run();
    const un = await send(s.app, 'PATCH', `/channels/${id}`, { archived: false }, s.owner.cookie);
    expect((await json<{ channel: ChannelInfo }>(un)).channel.archivedAt).toBeNull();

    const g = await send(s.app, 'PATCH', `/channels/${GENERAL}`, { archived: true }, s.owner.cookie);
    expect(g.status).toBe(403);
    expect((await json<{ error: { code: string } }>(g)).error.code).toBe('forbidden');
    expect((await send(s.app, 'PATCH', `/channels/${GENERAL}`, { name: 'lobby' }, s.owner.cookie)).status).toBe(403);
    expect((await send(s.app, 'PATCH', `/channels/${GENERAL}`, { topic: 'welcome' }, s.alice.cookie)).status).toBe(200);

    const dm = await json<{ channel: ChannelSummary }>(
      await send(s.app, 'POST', '/w/clubhack/dms', { userIds: [s.bob.userId] }, s.alice.cookie),
    );
    expect((await send(s.app, 'PATCH', `/channels/${dm.channel.id}`, { topic: 'x' }, s.alice.cookie)).status).toBe(403);
  });

  it('members add rejects non-workspace user IDs atomically (400 invalid_user, nothing added)', async () => {
    const s = await setup();
    const created = await json<{ channel: ChannelSummary }>(
      await send(s.app, 'POST', '/w/clubhack/channels', { name: 'crew', private: true }, s.alice.cookie),
    );
    const id = created.channel.id;
    const bob = await connect(s.app, s.bob.cookie);

    const bad = await send(s.app, 'POST', `/channels/${id}/members`, { userIds: [s.bob.userId, UNKNOWN] }, s.alice.cookie);
    expect(bad.status).toBe(400);
    expect((await json<{ error: { code: string } }>(bad)).error.code).toBe('invalid_user');
    expect(await memberCount(id)).toBe(1);
    await bob.none('membership', 100);

    // Not a channel member (private): 404.
    expect((await send(s.app, 'POST', `/channels/${id}/members`, { userIds: [s.bob.userId] }, s.carol.cookie)).status).toBe(404);

    const ok = await send(s.app, 'POST', `/channels/${id}/members`, { userIds: [s.bob.userId, s.alice.userId] }, s.alice.cookie);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ added: [s.bob.userId] });
    expect(await memberCount(id)).toBe(2);
    expect(await bob.next('membership')).toMatchObject({ action: 'added', channel: { id, name: 'crew', kind: 'private' } });

    // Deactivated members are not active workspace members.
    await env.DB.prepare('UPDATE workspace_members SET deactivated_at = 1 WHERE user_id = ?').bind(s.carol.userId).run();
    expect((await send(s.app, 'POST', `/channels/${id}/members`, { userIds: [s.carol.userId] }, s.alice.cookie)).status).toBe(400);

    // DMs cannot take members.
    const dm = await json<{ channel: ChannelSummary }>(
      await send(s.app, 'POST', '/w/clubhack/dms', { userIds: [s.bob.userId] }, s.alice.cookie),
    );
    expect((await send(s.app, 'POST', `/channels/${dm.channel.id}/members`, { userIds: [s.owner.userId] }, s.alice.cookie)).status).toBe(403);
  });

  it('open DM is idempotent regardless of order', async () => {
    const s = await setup();
    const bobSock = await connect(s.app, s.bob.cookie);
    const a = await send(s.app, 'POST', '/w/clubhack/dms', { userIds: [s.bob.userId] }, s.alice.cookie);
    expect(a.status).toBe(201);
    const ac = (await json<{ channel: ChannelSummary }>(a)).channel;
    expect(ac.kind).toBe('dm');
    expect(ac.name).toBeNull();
    expect(ac.dmUserIds).toEqual([s.alice.userId, s.bob.userId].sort());
    expect((await bobSock.next('membership')).action).toBe('added');

    const b = await send(s.app, 'POST', '/w/clubhack/dms', { userIds: [s.alice.userId] }, s.bob.cookie);
    expect(b.status).toBe(200);
    expect((await json<{ channel: ChannelSummary }>(b)).channel.id).toBe(ac.id);

    const again = await send(s.app, 'POST', '/w/clubhack/dms', { userIds: [s.bob.userId, s.bob.userId] }, s.alice.cookie);
    expect(again.status).toBe(200);
    expect((await json<{ channel: ChannelSummary }>(again)).channel.id).toBe(ac.id);
    await bobSock.none('membership', 100);
    expect(await memberCount(ac.id)).toBe(2);
  });

  it('group DM key includes the caller', async () => {
    const s = await setup();
    const res = await send(s.app, 'POST', '/w/clubhack/dms', { userIds: [s.carol.userId, s.bob.userId] }, s.alice.cookie);
    expect(res.status).toBe(201);
    const { channel } = await json<{ channel: ChannelSummary }>(res);
    const ids = [s.alice.userId, s.bob.userId, s.carol.userId].sort();
    expect(channel.dmUserIds).toEqual(ids);
    const row = await env.DB.prepare('SELECT dm_key FROM channels WHERE id = ?').bind(channel.id).first<{ dm_key: string }>();
    expect(row!.dm_key).toBe(ids.join(','));
    expect(await memberCount(channel.id)).toBe(3);

    const self = await send(s.app, 'POST', '/w/clubhack/dms', { userIds: [s.alice.userId] }, s.alice.cookie);
    expect(self.status).toBe(201);
    expect((await json<{ channel: ChannelSummary }>(self)).channel.dmUserIds).toEqual([s.alice.userId]);

    const bad = await send(s.app, 'POST', '/w/clubhack/dms', { userIds: [UNKNOWN] }, s.alice.cookie);
    expect(bad.status).toBe(400);
    expect((await json<{ error: { code: string } }>(bad)).error.code).toBe('invalid_user');
  });

  it('DM is invisible to non-participants', async () => {
    const s = await setup();
    const { channel } = await json<{ channel: ChannelSummary }>(
      await send(s.app, 'POST', '/w/clubhack/dms', { userIds: [s.bob.userId] }, s.alice.cookie),
    );
    expect((await send(s.app, 'GET', `/channels/${channel.id}/messages`, undefined, s.carol.cookie)).status).toBe(404);
    expect((await send(s.app, 'GET', `/channels/${channel.id}/messages`, undefined, s.bob.cookie)).status).toBe(200);
    const list = await json<{ channels: ChannelListing[] }>(await send(s.app, 'GET', '/w/clubhack/channels', undefined, s.alice.cookie));
    expect(list.channels.some((c) => c.id === channel.id)).toBe(false);
  });

  it('deactivating a member closes their socket with 4001', async () => {
    const s = await setup();
    const bob = await connect(s.app, s.bob.cookie);
    const alice = await connect(s.app, s.alice.cookie);
    const res = await send(s.app, 'PATCH', `/w/clubhack/members/${s.bob.userId}`, { deactivated: true }, s.owner.cookie);
    expect(res.status).toBe(200);
    expect((await bob.closed()).code).toBe(4001);
    // Other users' sockets stay open.
    alice.send({ t: 'send', clientId: 'c-deact-00001', channelId: GENERAL, body: 'still here' });
    await alice.next('ack');
    const sessions = await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?').bind(s.bob.userId).first<{ n: number }>();
    expect(sessions!.n).toBe(0);
  });
});
