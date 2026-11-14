import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FILES_QUOTA_BYTES, type CustomEmoji, type FileInfo } from '@backroom/protocol';
import { createApp } from '../src/app';
import { createCustomEmoji } from '../src/emoji/custom';
import { cleanupOrphans } from '../src/files/cleanup';
import { fileKey, storeUpload } from '../src/files/store';
import {
  blobKeys,
  captureMailer,
  describeBackends,
  env,
  insertFile,
  patchBlobBinding,
  png,
  resetDb,
  seedUsers,
  send,
  testDeps,
  uploadEmoji,
  uploadFile,
  webp,
} from './helpers';

const T = 1_800_000_000_000;
const H = 3_600_000;
const WS = '01JCLUBHACK0000000000000WS';
const EMOJI_PREFIX = `ws/${WS}/emoji/`;
const QUOTA_MESSAGE = 'This workspace has used its 900 MB of storage (files, thumbnails and custom emoji).';
const LIMIT = () => Promise.reject(new Error('KV delete() limit exceeded for the day.'));

beforeEach(resetDb);
let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
  vi.restoreAllMocks();
});

async function setup() {
  const { mailer, sent } = captureMailer();
  const app = createApp(testDeps({ mailer }));
  // Custom emoji need an admin by default: the owner uploads them.
  const [owner, alice] = await seedUsers(app, sent, ['owner@test.dev', 'alice@test.dev']);
  return { app, owner: owner!, alice: alice! };
}

async function created(res: Response): Promise<FileInfo> {
  expect(res.status).toBe(201);
  return ((await res.json()) as { file: FileInfo }).file;
}

async function body(res: Response): Promise<{ error: { code: string; message: string } }> {
  return (await res.json()) as { error: { code: string; message: string } };
}

async function postThumb(app: ReturnType<typeof createApp>, cookie: string, id: string, bytes: Uint8Array): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.request(
    `/files/${id}/thumb`,
    { method: 'POST', headers: { Origin: 'https://app.test', Cookie: cookie, 'Content-Type': 'image/webp' }, body: bytes },
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

const thumbOf = async (id: string) =>
  (await env.DB.prepare('SELECT thumb_key AS k, thumb_size AS s FROM files WHERE id = ?').bind(id).first<{ k: string | null; s: number }>())!;

/** A filler row (no blob) that makes the workspace use exactly `bytes`. */
const fill = (uploaderId: string, bytes: number) => insertFile({ uploaderId, size: bytes, name: 'filler.bin' });

describeBackends('blob quota (files + thumbnails + custom emoji)', (backend) => {
  it('thumbnails count: their size is recorded and fills the quota', async () => {
    const s = await setup();
    const img = await created(await uploadFile(s.app, s.alice.cookie, png(1000, 800, 1000), { name: 'a.png' }));
    expect((await postThumb(s.app, s.alice.cookie, img.id, webp(720, 576, 300))).status).toBe(200);
    expect((await thumbOf(img.id)).s).toBe(300);
    await fill(s.owner.userId, FILES_QUOTA_BYTES - 1000 - 300);
    const over = await uploadFile(s.app, s.alice.cookie, new Uint8Array(1), { name: 'one' });
    expect(over.status).toBe(413);
    expect(await body(over)).toEqual({ error: { code: 'quota_exceeded', message: QUOTA_MESSAGE } });
  });

  it('a thumbnail that would exceed the quota is 413 quota_exceeded and leaves no blob', async () => {
    const s = await setup();
    const img = await created(await uploadFile(s.app, s.alice.cookie, png(1000, 800, 1000), { name: 'a.png' }));
    await fill(s.owner.userId, FILES_QUOTA_BYTES - 1000 - 299);
    const res = await postThumb(s.app, s.alice.cookie, img.id, webp(720, 576, 300));
    expect(res.status).toBe(413);
    expect((await body(res)).error.code).toBe('quota_exceeded');
    expect(await thumbOf(img.id)).toEqual({ k: null, s: 0 });
    expect(await blobKeys(`${fileKey(WS, img.id)}-thumb`)).toEqual([]);
  });

  it('two thumbnails racing for the last bytes: the conditional UPDATE lets one in and removes the loser’s blob', async () => {
    const s = await setup();
    const a = await created(await uploadFile(s.app, s.alice.cookie, png(1000, 800, 1000), { name: 'a.png' }));
    const b = await created(await uploadFile(s.app, s.alice.cookie, png(1000, 800, 1000), { name: 'b.png' }));
    await fill(s.owner.userId, FILES_QUOTA_BYTES - 2000 - 400); // room for one 300-byte thumbnail, not two
    const [ra, rb] = await Promise.all([
      postThumb(s.app, s.alice.cookie, a.id, webp(720, 576, 300)),
      postThumb(s.app, s.alice.cookie, b.id, webp(720, 576, 300)),
    ]);
    expect([ra.status, rb.status].sort()).toEqual([200, 413]);
    const loser = ra.status === 413 ? a : b;
    const winner = ra.status === 413 ? b : a;
    expect((await body(ra.status === 413 ? ra : rb)).error.code).toBe('quota_exceeded');
    expect(await blobKeys(`${fileKey(WS, loser.id)}-thumb`)).toEqual([]);
    expect(await blobKeys(`${fileKey(WS, winner.id)}-thumb`)).toEqual([(await thumbOf(winner.id)).k]);
  });

  it('custom emoji count toward file uploads, and deleting one frees its bytes', async () => {
    const s = await setup();
    const image = png(32, 32, 2000);
    const res = await uploadEmoji(s.app, s.owner.cookie, 'big', image);
    expect(res.status).toBe(201);
    const emoji = ((await res.json()) as { emoji: CustomEmoji }).emoji;
    const row = await env.DB.prepare('SELECT size FROM custom_emoji WHERE id = ?').bind(emoji.id).first<{ size: number }>();
    expect(row?.size).toBe(2000);
    await fill(s.owner.userId, FILES_QUOTA_BYTES - 2000);
    const over = await uploadFile(s.app, s.alice.cookie, new Uint8Array(1), { name: 'one' });
    expect(over.status).toBe(413);
    expect((await send(s.app, 'DELETE', `/emoji/${emoji.id}`, undefined, s.owner.cookie)).status).toBe(200);
    await created(await uploadFile(s.app, s.alice.cookie, new Uint8Array(1), { name: 'one' }));
  });

  it('files count toward custom emoji uploads (route pre-check and the conditional insert)', async () => {
    const s = await setup();
    await fill(s.owner.userId, FILES_QUOTA_BYTES - 10);
    const res = await uploadEmoji(s.app, s.owner.cookie, 'nope', png(32, 32, 100));
    expect(res.status).toBe(413);
    expect(await body(res)).toEqual({ error: { code: 'quota_exceeded', message: QUOTA_MESSAGE } });
    expect(await blobKeys(EMOJI_PREFIX)).toEqual([]);

    // Past the route's pre-check (a race), the conditional insert refuses and the blob is removed.
    const err = await createCustomEmoji(env, {
      workspaceId: WS, userId: s.owner.userId, name: 'race', bytes: png(32, 32, 100), mime: 'image/png', now: T,
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 413, code: 'quota_exceeded' });
    expect(await blobKeys(EMOJI_PREFIX)).toEqual([]);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM custom_emoji').first<{ n: number }>())!.n).toBe(0);
  });

  it('removing an orphan file (and its thumbnail) frees quota', async () => {
    const s = await setup();
    const orphan = await insertFile({ uploaderId: s.owner.userId, size: FILES_QUOTA_BYTES - 300, createdAt: T - 25 * H, thumb: true });
    expect((await thumbOf(orphan)).s).toBeGreaterThan(0);
    await env.DB.prepare('UPDATE files SET thumb_size = 300 WHERE id = ?').bind(orphan).run();
    expect((await uploadFile(s.app, s.alice.cookie, new Uint8Array(1), { name: 'one' })).status).toBe(413);
    expect((await cleanupOrphans(env, T)).deleted).toBe(1);
    await created(await uploadFile(s.app, s.alice.cookie, new Uint8Array(1), { name: 'one' }));
  });

  it.runIf(backend === 'kv')('a cleanup delete at the KV limit logs blob_leaked with the key class only', async () => {
    const s = await setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    restore = patchBlobBinding(() => ({ delete: LIMIT as never }));

    // file: the conditional insert refuses after the put
    await fill(s.owner.userId, FILES_QUOTA_BYTES - 5);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(10));
        c.close();
      },
    });
    const e1 = await storeUpload(env, {
      workspaceId: WS, userId: s.alice.userId, name: 'x', declaredType: null, length: 10, body: stream, now: T,
    }).catch((e: unknown) => e);
    expect(e1).toMatchObject({ code: 'quota_exceeded' });

    // emoji: past the pre-check, the conditional insert refuses after the put
    const e2 = await createCustomEmoji(env, {
      workspaceId: WS, userId: s.owner.userId, name: 'leak', bytes: png(32, 32, 100), mime: 'image/png', now: T,
    }).catch((e: unknown) => e);
    expect(e2).toMatchObject({ code: 'quota_exceeded' });

    const leaks = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('blob_leaked'));
    expect(leaks.map((m) => JSON.parse(m))).toEqual([
      { level: 'warn', code: 'blob_leaked', kind: 'file' },
      { level: 'warn', code: 'blob_leaked', kind: 'emoji' },
    ]);
    for (const m of leaks) expect(m).not.toContain('ws/');
  });

  it.runIf(backend === 'kv')('a thumbnail cleanup at the KV limit logs blob_leaked kind thumb', async () => {
    const s = await setup();
    const a = await created(await uploadFile(s.app, s.alice.cookie, png(1000, 800, 1000), { name: 'a.png' }));
    const b = await created(await uploadFile(s.app, s.alice.cookie, png(1000, 800, 1000), { name: 'b.png' }));
    await fill(s.owner.userId, FILES_QUOTA_BYTES - 2000 - 400);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    restore = patchBlobBinding(() => ({ delete: LIMIT as never }));
    const statuses = (
      await Promise.all([postThumb(s.app, s.alice.cookie, a.id, webp(720, 576, 300)), postThumb(s.app, s.alice.cookie, b.id, webp(720, 576, 300))])
    ).map((r) => r.status);
    expect(statuses.sort()).toEqual([200, 413]);
    const leaks = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('blob_leaked'));
    expect(leaks.map((m) => JSON.parse(m))).toEqual([{ level: 'warn', code: 'blob_leaked', kind: 'thumb' }]);
  });
});
