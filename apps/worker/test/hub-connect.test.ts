import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { getAtt } from '../src/hub/attachment';
import { CATCHUP_FRAME_BUDGET } from '../src/hub/WorkspaceHub';
import { sendMessage } from '../src/messaging/store';
import { GENERAL, captureMailer, insertChannel, resetDb, seedUsers, testDeps } from './helpers';
import { adopt, closeAll, connect, hubStub, upgrade } from './ws';

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
  const [owner, alice, bob] = await seedUsers(app, sent, ['owner@test.dev', 'alice@test.dev', 'bob@test.dev']);
  const say = async (channelId = GENERAL, body = 'hi') => {
    const r = await sendMessage(env.DB, {
      clientId: crypto.randomUUID(),
      channelId,
      userId: alice!.userId,
      parentId: null,
      body,
      alsoInChannel: false,
      fileIds: [],
      now: 1_000,
    });
    if (!r.ok) throw new Error(r.code);
    return r.message;
  };
  return { app, sent, owner: owner!, alice: alice!, bob: bob!, say };
}

const tokenOf = (cookie: string) => cookie.split('=')[1]!;

describe('/ws upgrade', () => {
  it('upgrade without Upgrade header is 426', async () => {
    const { app, alice } = await setup();
    const res = await upgrade(app, { Cookie: alice.cookie, Origin: 'https://app.test' });
    expect(res.status).toBe(426);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('upgrade_required');
  });

  it('without session is 401', async () => {
    const { app } = await setup();
    const res = await upgrade(app, { Origin: 'https://app.test', Upgrade: 'websocket' });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unauthenticated');
  });

  it('cookie with Origin https://evil.test is 403 bad_origin', async () => {
    const { app, alice } = await setup();
    const res = await upgrade(app, { Cookie: alice.cookie, Origin: 'https://evil.test', Upgrade: 'websocket' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('bad_origin');
  });

  it('cookie with no Origin is 403', async () => {
    const { app, alice } = await setup();
    const res = await upgrade(app, { Cookie: alice.cookie, Upgrade: 'WebSocket' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('bad_origin');
  });

  it('Bearer with no Origin is 101', async () => {
    const { app, alice } = await setup();
    const res = await upgrade(app, { Authorization: `Bearer ${tokenOf(alice.cookie)}`, Upgrade: 'websocket' });
    expect(res.status).toBe(101);
    adopt(res);
  });

  it('Bearer with a foreign Origin is 403', async () => {
    const { app, alice } = await setup();
    const res = await upgrade(app, {
      Authorization: `Bearer ${tokenOf(alice.cookie)}`,
      Origin: 'https://evil.test',
      Upgrade: 'websocket',
    });
    expect(res.status).toBe(403);
  });

  it('unknown workspace slug is 404', async () => {
    const { app, alice } = await setup();
    const res = await upgrade(app, { Cookie: alice.cookie, Origin: 'https://app.test', Upgrade: 'websocket' }, 'nope');
    expect(res.status).toBe(404);
  });

  it('stale cookie does not block a valid Bearer', async () => {
    const { app, alice } = await setup();
    const res = await app.request(
      '/me',
      { headers: { Cookie: 'backroom_session=garbage', Authorization: `Bearer ${tokenOf(alice.cookie)}` } },
      env,
    );
    expect(res.status).toBe(200);
  });

  it('a session renewed during upgrade still connects', async () => {
    const { alice } = await setup();
    const later = createApp(testDeps({ now: () => 1_800_000_000_000 + 16 * 86_400_000 }));
    const res = await upgrade(later, { Cookie: alice.cookie, Origin: 'https://app.test', Upgrade: 'websocket' });
    expect(res.status).toBe(101);
    adopt(res);
  });
});

describe('WorkspaceHub', () => {
  it('ping is answered with pong', async () => {
    const { app, alice } = await setup();
    const a = await connect(app, alice.cookie);
    a.send('{"t":"ping"}');
    expect(await a.next('pong')).toEqual({ t: 'pong' });
  });

  it('hello replays missed messages as catchup', async () => {
    const { app, alice, say } = await setup();
    for (let i = 0; i < 3; i++) await say();
    const a = await connect(app, alice.cookie);
    a.send({ t: 'hello', lastSeen: { [GENERAL]: 1 } });
    const c = await a.next('catchup');
    expect(c.messages.map((m) => m.seq)).toEqual([2, 3]);
    await a.none('stale');
  });

  it('more than 200 missed sends stale, not messages', async () => {
    const { app, alice, say } = await setup();
    for (let i = 0; i < 201; i++) await say();
    const a = await connect(app, alice.cookie);
    a.send({ t: 'hello', lastSeen: { [GENERAL]: 0 } });
    expect((await a.next('catchup')).messages).toEqual([]);
    expect(await a.next('stale')).toEqual({ t: 'stale', channelId: GENERAL });
  });

  it('catchup carries a presence snapshot', async () => {
    const { app, alice, bob } = await setup();
    const a = await connect(app, alice.cookie);
    a.send({ t: 'activity' });
    await a.next('presence');
    const b = await connect(app, bob.cookie);
    b.send({ t: 'hello', lastSeen: {} });
    const c = await b.next('catchup');
    expect(c.presence).toContainEqual({ userId: alice.userId, state: 'active' });
  });

  it('presence: activity announces active to others; closing the last socket announces away', async () => {
    const { app, alice, bob } = await setup();
    const a = await connect(app, alice.cookie);
    const b = await connect(app, bob.cookie);
    a.send({ t: 'activity' });
    expect(await b.next('presence')).toEqual({ t: 'presence', userId: alice.userId, state: 'active' });
    a.send({ t: 'activity' });
    await b.none('presence');
    a.close();
    expect(await b.next('presence')).toEqual({ t: 'presence', userId: alice.userId, state: 'away' });
  });

  it('a second tab of an active user does not re-announce, and closing one tab keeps them active', async () => {
    const { app, alice, bob } = await setup();
    const a1 = await connect(app, alice.cookie);
    const b = await connect(app, bob.cookie);
    a1.send({ t: 'activity' });
    await b.next('presence');
    const a2 = await connect(app, alice.cookie);
    a2.send({ t: 'activity' });
    await b.none('presence');
    a1.close();
    await b.none('presence');
    a2.close();
    expect(await b.next('presence')).toEqual({ t: 'presence', userId: alice.userId, state: 'away' });
  });

  it('presence goes away after 10 minutes via alarm', async () => {
    const { app, alice, bob } = await setup();
    const a = await connect(app, alice.cookie);
    const b = await connect(app, bob.cookie);
    const T = Date.now();
    await runInDurableObject(hubStub(), (hub) => {
      hub.now = () => T;
    });
    a.send({ t: 'activity' });
    expect(await b.next('presence')).toEqual({ t: 'presence', userId: alice.userId, state: 'active' });
    expect(await runInDurableObject(hubStub(), (_hub, state) => state.storage.getAlarm())).not.toBeNull();
    await runInDurableObject(hubStub(), (hub) => {
      hub.now = () => T + 600_000;
    });
    expect(await runDurableObjectAlarm(hubStub())).toBe(true);
    expect(await b.next('presence')).toEqual({ t: 'presence', userId: alice.userId, state: 'away' });
  });

  it('attachment survives hibernation with 60 channels', async () => {
    const { app, alice, say } = await setup();
    for (let i = 0; i < 60; i++) {
      await insertChannel({ name: `extra-${i}`, kind: 'public', memberIds: [alice.userId] });
    }
    await say();
    const a = await connect(app, alice.cookie);
    const before = await runInDurableObject(hubStub(), (hub) => hub);
    await evictDurableObject(hubStub());
    const [lens, same] = await runInDurableObject(hubStub(), (hub, state) => [
      state.getWebSockets(alice.userId).map((ws) => getAtt(ws).channelIds.length),
      hub === before,
    ]);
    expect(same).toBe(false); // a fresh instance: the attachment, not memory, carried the state
    expect(lens).toEqual([61]);
    a.send({ t: 'hello', lastSeen: { [GENERAL]: 0 } });
    expect((await a.next('catchup')).messages.map((m) => m.seq)).toEqual([1]);
  });

  it('catchup stays within its byte budget; overflow channels are sent as stale', async () => {
    const { app, alice, say } = await setup();
    const big = 'x'.repeat(40_000);
    const chans: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = await insertChannel({ name: `big-${i}`, kind: 'public', memberIds: [alice.userId] });
      chans.push(id);
      for (let j = 0; j < 10; j++) await say(id, big); // ~400 KB per channel, ~1.2 MB in total
    }
    const a = await connect(app, alice.cookie);
    a.send({ t: 'hello', lastSeen: Object.fromEntries(chans.map((id) => [id, 0])) });
    const c = await a.next('catchup');
    const bytes = new TextEncoder().encode(JSON.stringify(c.messages)).byteLength;
    expect(bytes).toBeLessThanOrEqual(CATCHUP_FRAME_BUDGET);
    const delivered = [...new Set(c.messages.map((m) => m.channelId))];
    expect(delivered).toHaveLength(2);
    for (const id of delivered) expect(c.messages.filter((m) => m.channelId === id)).toHaveLength(10);
    const overflow = chans.filter((id) => !delivered.includes(id));
    expect(await a.next('stale')).toEqual({ t: 'stale', channelId: overflow[0] });
    await a.none('stale');
  });

  it('a failed catch-up marks every requested channel stale', async () => {
    const { app, alice, say } = await setup();
    await say();
    const a = await connect(app, alice.cookie);
    await runInDurableObject(hubStub(), (hub) => {
      const h = hub as unknown as { env: { DB: D1Database } };
      const real = h.env.DB;
      h.env = {
        ...h.env,
        DB: {
          ...real,
          prepare: () => {
            throw new Error('d1 down');
          },
          batch: () => Promise.reject(new Error('d1 down')),
        } as unknown as D1Database,
      };
    });
    try {
      a.send({ t: 'hello', lastSeen: { [GENERAL]: 0, '01JCLUBHACK0000000000000RD': 0 } });
      expect((await a.next('catchup')).messages).toEqual([]);
      // Only channels the socket belongs to (random is not one of alice's channels).
      expect(await a.next('stale')).toEqual({ t: 'stale', channelId: GENERAL });
      await a.none('stale');
    } finally {
      await evictDurableObject(hubStub()); // drop the patched env; sockets hibernate and survive
    }
    a.send({ t: 'hello', lastSeen: { [GENERAL]: 0 } });
    expect((await a.next('catchup')).messages.map((m) => m.seq)).toEqual([1]);
  });

  it('a new tab of an active user inherits their latest activity', async () => {
    const { app, alice } = await setup();
    const T = Date.now();
    await runInDurableObject(hubStub(), (hub) => {
      hub.now = () => T;
    });
    const a1 = await connect(app, alice.cookie);
    a1.send({ t: 'activity' });
    await a1.next('presence');
    await connect(app, alice.cookie);
    const atts = await runInDurableObject(hubStub(), (_hub, state) =>
      state.getWebSockets(alice.userId).map((ws) => getAtt(ws)),
    );
    expect(atts.map((x) => [x.lastActivityAt, x.announced])).toEqual([
      [T, 'active'],
      [T, 'active'],
    ]);
  });

  it('oversized frames close the socket with 1009', async () => {
    const { app, alice } = await setup();
    const a = await connect(app, alice.cookie);
    a.send('x'.repeat(262_145));
    expect((await a.closed()).code).toBe(1009);
  });

  it('invalid frames without clientId are dropped and the socket stays usable', async () => {
    const { app, alice } = await setup();
    const a = await connect(app, alice.cookie);
    a.send('not json');
    a.send({ t: 'nope' } as never);
    a.send('{"t":"ping"}');
    await a.next('pong');
    await a.none('nack');
  });
});
