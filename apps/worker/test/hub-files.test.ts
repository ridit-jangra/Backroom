import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FileInfo } from '@backroom/protocol';
import { createApp } from '../src/app';
import { GENERAL, captureMailer, insertChannel, insertFile, png, resetDb, seedUsers, testDeps, uploadFile } from './helpers';
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
  const upload = async (cookie: string, name: string, bytes: Uint8Array, type = 'application/octet-stream') => {
    const res = await uploadFile(app, cookie, bytes, { name, type });
    if (res.status !== 201) throw new Error(`upload failed: ${res.status}`);
    return ((await res.json()) as { file: FileInfo }).file;
  };
  return { app, owner: owner!, alice: alice!, bob: bob!, carol: carol!, upload };
}
type S = Awaited<ReturnType<typeof setup>>;

async function connectAll(s: S) {
  return {
    owner: await connect(s.app, s.owner.cookie),
    alice: await connect(s.app, s.alice.cookie),
    bob: await connect(s.app, s.bob.cookie),
    carol: await connect(s.app, s.carol.cookie),
  };
}

const linkCount = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM message_files').first<{ n: number }>())!.n;
const lastSeq = async () =>
  (await env.DB.prepare('SELECT last_seq AS s FROM channels WHERE id = ?').bind(GENERAL).first<{ s: number }>())!.s;
const text = (s: string) => new TextEncoder().encode(s);

let n = 0;
const cid = () => `files-client-${++n}`;

async function sendFiles(sock: TestSocket, fileIds: string[], body = '', channelId = GENERAL) {
  const clientId = cid();
  sock.send({ t: 'send', clientId, channelId, body, fileIds });
  return clientId;
}

describe('hub files', () => {
  it('send with fileIds links files and broadcasts them', async () => {
    const s = await setup();
    const a = await s.upload(s.alice.cookie, 'a.png', png(4, 3), 'image/png');
    const b = await s.upload(s.alice.cookie, 'b.txt', text('hello'), 'text/plain');
    const { alice, bob } = await connectAll(s);
    await sendFiles(alice, [b.id, a.id]);
    const ack = await alice.next('ack');
    const files = ack.message.files!;
    expect(files.map((f) => f.id)).toEqual([a.id, b.id].sort());
    const byId = new Map([a, b].map((f) => [f.id, f]));
    expect(files[0]).toEqual(byId.get(files[0]!.id));
    expect(files[1]).toEqual(byId.get(files[1]!.id));
    const nm = await bob.next('message.new');
    expect(nm.message.files).toEqual(files);
    expect(await linkCount()).toBe(2);
  });

  it("fileIds must be the sender's unattached uploads in this workspace", async () => {
    const s = await setup();
    const a = await s.upload(s.alice.cookie, 'a.txt', text('a'));
    const used = await s.upload(s.alice.cookie, 'used.txt', text('u'));
    const bobs = await s.upload(s.bob.cookie, 'bob.txt', text('b'));
    const other = await insertFile({ workspaceId: '01JOTHERWS0000000000000000', uploaderId: s.alice.userId });
    const { alice } = await connectAll(s);
    await sendFiles(alice, [used.id], 'first');
    await alice.next('ack');
    const before = await lastSeq();
    const cases: string[][] = [[bobs.id], [used.id], [other], ['01JNOSUCHFILE0000000000000'], [a.id, a.id], []];
    for (const ids of cases) {
      const clientId = await sendFiles(alice, ids);
      expect(await alice.next('nack')).toEqual({ t: 'nack', clientId, code: 'invalid' });
    }
    expect(await lastSeq()).toBe(before);
    expect(await linkCount()).toBe(1);
  });

  it('resending the same clientId acks once with the same files', async () => {
    const s = await setup();
    const a = await s.upload(s.alice.cookie, 'a.txt', text('a'));
    const b = await s.upload(s.alice.cookie, 'b.txt', text('b'));
    const { alice, bob } = await connectAll(s);
    const clientId = cid();
    alice.send({ t: 'send', clientId, channelId: GENERAL, body: 'two', fileIds: [a.id, b.id] });
    const first = await alice.next('ack');
    alice.send({ t: 'send', clientId, channelId: GENERAL, body: 'two', fileIds: [a.id, b.id] });
    const second = await alice.next('ack');
    expect(second.message.id).toBe(first.message.id);
    expect(second.message.files).toEqual(first.message.files);
    expect(first.message.files).toHaveLength(2);
    expect(await linkCount()).toBe(2);
    await bob.next('message.new');
    await bob.none('message.new');
  });

  it('a duplicate found only through D1 still carries files', async () => {
    const s = await setup();
    const a = await s.upload(s.alice.cookie, 'a.txt', text('a'));
    const { alice } = await connectAll(s);
    const clientId = cid();
    alice.send({ t: 'send', clientId, channelId: GENERAL, body: '', fileIds: [a.id] });
    const first = await alice.next('ack');
    // Forget the in-memory clientId map so the second send reaches the D1 backstop.
    await runInDurableObject(hubStub(), (hub) => {
      (hub as unknown as { recent: Map<string, unknown> }).recent.clear();
    });
    alice.send({ t: 'send', clientId, channelId: GENERAL, body: '', fileIds: [a.id] });
    const second = await alice.next('ack');
    expect(second.message.id).toBe(first.message.id);
    expect(second.message.files).toEqual(first.message.files);
  });

  it('deleting a message unlinks its files', async () => {
    const s = await setup();
    const a = await s.upload(s.alice.cookie, 'a.txt', text('a'));
    const { alice, bob } = await connectAll(s);
    await sendFiles(alice, [a.id], 'with file');
    const ack = await alice.next('ack');
    alice.send({ t: 'delete', messageId: ack.message.id });
    const del = await bob.next('message.delete');
    expect(del.message.files).toEqual([]);
    expect(await linkCount()).toBe(0);
    expect(await env.DB.prepare('SELECT id FROM files WHERE id = ?').bind(a.id).first()).not.toBeNull();
  });

  it('notify preview names the files of a file-only message', async () => {
    const s = await setup();
    const dm = await insertChannel({
      name: null,
      kind: 'dm',
      memberIds: [s.alice.userId, s.bob.userId],
      dmKey: [s.alice.userId, s.bob.userId].sort().join(','),
    });
    const f = await s.upload(s.alice.cookie, 'report.pdf', text('%PDF-1.7\n'), 'application/pdf');
    const { alice, bob } = await connectAll(s);
    await sendFiles(alice, [f.id], '', dm);
    await alice.next('ack');
    expect((await bob.next('notify')).preview).toBe('report.pdf');
  });
});
