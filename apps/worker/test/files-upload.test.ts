import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { FILES_QUOTA_BYTES, type FileInfo } from '@backroom/protocol';
import { createApp } from '../src/app';
import { FILE_KEY_RE, UploadStreamError, fileKey, putExact, storeUpload, thumbKeyOf } from '../src/files/store';
import { captureMailer, insertFile, png, resetDb, seedUsers, testDeps, uploadFile, webp } from './helpers';

beforeEach(resetDb);

const WS = '01JCLUBHACK0000000000000WS';
const text = (s: string) => new TextEncoder().encode(s);

async function thumbKeys(id: string): Promise<string[]> {
  return (await env.BUCKET.list({ prefix: `${fileKey(WS, id)}-thumb` })).objects.map((o) => o.key);
}

async function storedThumbKey(id: string): Promise<string | null> {
  return (await env.DB.prepare('SELECT thumb_key AS k FROM files WHERE id = ?').bind(id).first<{ k: string | null }>())?.k ?? null;
}

/** An ExecutionContext that records what the handler hands to waitUntil. */
function recordingCtx(): { ctx: ExecutionContext; waited: Promise<unknown>[] } {
  const waited: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void waited.push(p),
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
  return { ctx, waited };
}

async function setup() {
  const { mailer, sent } = captureMailer();
  const app = createApp(testDeps({ mailer }));
  const [owner, alice, bob] = await seedUsers(app, sent, ['owner@test.dev', 'alice@test.dev', 'bob@test.dev']);
  return { app, owner: owner!, alice: alice!, bob: bob! };
}

async function errCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

async function created(res: Response): Promise<FileInfo> {
  expect(res.status).toBe(201);
  return ((await res.json()) as { file: FileInfo }).file;
}

async function fileKeys(): Promise<string[]> {
  return (await env.BUCKET.list({ prefix: `ws/${WS}/` })).objects.map((o) => o.key).filter((k) => !k.includes('/emoji/'));
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

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
}

describe('file upload', () => {
  it('uploads a PNG: streamed to R2, dimensions and type from bytes', async () => {
    const s = await setup();
    const bytes = png(800, 600, 5_000);
    const file = await created(await uploadFile(s.app, s.alice.cookie, bytes, { name: 'cat.png', type: 'application/octet-stream' }));
    expect(file).toEqual({ id: file.id, name: 'cat.png', mime: 'image/png', size: 5000, width: 800, height: 600, hasThumb: false });
    expect(file.id).toMatch(/^[0-9A-Z]{26}$/);
    const obj = await env.BUCKET.get(`ws/${WS}/${file.id}`);
    expect(obj).not.toBeNull();
    expect(new Uint8Array(await obj!.arrayBuffer())).toEqual(bytes);
    const { results } = await env.DB.prepare('SELECT uploader_id, r2_key, thumb_key FROM files').all<{
      uploader_id: string;
      r2_key: string;
      thumb_key: string | null;
    }>();
    expect(results).toEqual([{ uploader_id: s.alice.userId, r2_key: `ws/${WS}/${file.id}`, thumb_key: null }]);
  });

  it('non-images keep a safe type; names are sanitized', async () => {
    const s = await setup();
    const f = await created(await uploadFile(s.app, s.alice.cookie, text('hello'), { name: 'a/b\r\n.txt', type: 'text/plain' }));
    expect(f).toMatchObject({ mime: 'text/plain', name: 'a_b.txt', size: 5, width: null, height: null, hasThumb: false });
    const html = await created(await uploadFile(s.app, s.alice.cookie, text('<html><script>x</script>'), { name: 'x.png', type: 'image/png' }));
    expect(html.mime).toBe('application/octet-stream');
    const empty = await created(await uploadFile(s.app, s.alice.cookie, new Uint8Array(0), { name: 'empty' }));
    expect(empty).toMatchObject({ size: 0, mime: 'application/octet-stream' });
    expect(await env.BUCKET.head(fileKey(WS, empty.id))).not.toBeNull();
    const unnamed = await created(await uploadFile(s.app, s.alice.cookie, text('x')));
    expect(unnamed.name).toBe('file');
  });

  it('size limits', async () => {
    const s = await setup();
    const max = await created(await uploadFile(s.app, s.alice.cookie, new Uint8Array(26_214_400), { name: 'max.bin' }));
    expect(max.size).toBe(26_214_400);
    expect(await fileKeys()).toEqual([fileKey(WS, max.id)]);

    const big = await uploadFile(s.app, s.alice.cookie, new Uint8Array(1), { length: '26214401' });
    expect(big.status).toBe(413);
    expect(await errCode(big)).toBe('too_large');

    const chunked = await uploadFile(s.app, s.alice.cookie, text('abc'), { length: null });
    expect(chunked.status).toBe(411);
    expect(await errCode(chunked)).toBe('length_required');

    for (const bad of ['-1', '1e3', '0x10', '1234567890', '', '5, 5']) {
      const res = await uploadFile(s.app, s.alice.cookie, text('abc'), { length: bad });
      expect(res.status, bad).toBe(411);
    }
    expect(await fileKeys()).toEqual([fileKey(WS, max.id)]);
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM files').first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it('a body shorter than its Content-Length leaves no row and no object', async () => {
    const s = await setup();
    const res = await uploadFile(s.app, s.alice.cookie, text('short'), { length: '100' });
    expect(res.status).toBe(400);
    expect(await errCode(res)).toBe('invalid_request');
    expect(await fileKeys()).toEqual([]);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM files').first<{ n: number }>())?.n).toBe(0);
  });

  it('quota counts files.size, not R2, and excludes emoji', async () => {
    const s = await setup();
    await insertFile({ uploaderId: s.owner.userId, size: FILES_QUOTA_BYTES - 10 });
    await env.BUCKET.put(`ws/${WS}/emoji/01JEMOJI000000000000000000`, new Uint8Array(1_048_576));
    await created(await uploadFile(s.app, s.alice.cookie, new Uint8Array(10), { name: 'ten' }));
    const over = await uploadFile(s.app, s.alice.cookie, new Uint8Array(1), { name: 'one' });
    expect(over.status).toBe(413);
    expect(await errCode(over)).toBe('quota_exceeded');
  });

  it('concurrent uploads cannot overshoot the quota; failed uploads leave nothing behind', async () => {
    const s = await setup();
    await insertFile({ uploaderId: s.owner.userId, size: FILES_QUOTA_BYTES - 1_500_000 });
    const [a, b] = await Promise.all([
      uploadFile(s.app, s.alice.cookie, new Uint8Array(1_000_000), { name: 'a' }),
      uploadFile(s.app, s.bob.cookie, new Uint8Array(1_000_000), { name: 'b' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 413]);
    const winner = a.status === 201 ? a : b;
    const loser = a.status === 201 ? b : a;
    expect(await errCode(loser)).toBe('quota_exceeded');
    const { id } = ((await winner.json()) as { file: FileInfo }).file;
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM files').first<{ n: number }>())?.n).toBe(2);
    expect(await fileKeys()).toEqual([fileKey(WS, id)]);
  });

  it('the conditional insert re-checks the quota after the pre-check and removes the object', async () => {
    const s = await setup();
    await insertFile({ uploaderId: s.owner.userId, size: FILES_QUOTA_BYTES - 5 });
    const err = await storeUpload(env, {
      workspaceId: WS,
      userId: s.alice.userId,
      name: 'x',
      declaredType: null,
      length: 10,
      body: streamOf(new Uint8Array(10)),
      now: 1_800_000_000_000,
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 413, code: 'quota_exceeded' });
    expect(await fileKeys()).toEqual([]);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM files').first<{ n: number }>())?.n).toBe(1);
  });

  it('putExact rejects a short stream and leaves no object', async () => {
    const key = `ws/${WS}/01JSHORT000000000000000000`;
    await expect(putExact(env.BUCKET, key, streamOf(new Uint8Array(50)), 100)).rejects.toBeInstanceOf(UploadStreamError);
    expect(await env.BUCKET.head(key)).toBeNull();
    await expect(putExact(env.BUCKET, key, streamOf(new Uint8Array(150)), 100)).rejects.toBeInstanceOf(UploadStreamError);
    expect(await env.BUCKET.head(key)).toBeNull();
    await putExact(env.BUCKET, key, streamOf(new Uint8Array(100)), 100);
    expect((await env.BUCKET.head(key))?.size).toBe(100);
  });

  it('the upload work runs under waitUntil, so the row is inserted even if the response is never delivered', async () => {
    const s = await setup();
    const { ctx, waited } = recordingCtx();
    const res = await s.app.request(
      '/w/clubhack/files?name=a.bin',
      {
        method: 'POST',
        headers: { Origin: 'https://app.test', Cookie: s.alice.cookie, 'Content-Length': '1000' },
        body: new Uint8Array(1000),
      },
      env,
      ctx,
    );
    expect(waited).toHaveLength(1);
    await Promise.all(waited);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM files').first<{ n: number }>())?.n).toBe(1);
    expect(res.status).toBe(201);
  });

  it('a Content-Length with no body is 400', async () => {
    const s = await setup();
    const ctx = createExecutionContext();
    const res = await s.app.request(
      '/w/clubhack/files?name=x',
      { method: 'POST', headers: { Origin: 'https://app.test', Cookie: s.alice.cookie, 'Content-Length': '10' } },
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(400);
    expect(await errCode(res)).toBe('invalid_request');
    expect(await fileKeys()).toEqual([]);
  });

  it('R2 failures are 500 upload_failed (logged), body failures 400; nothing is left behind', async () => {
    const s = await setup();
    const deleted: string[] = [];
    const failing = {
      put: async () => {
        throw new Error('r2 down');
      },
      delete: async (k: string) => void deleted.push(k),
    } as unknown as R2Bucket;
    const errors: string[] = [];
    const orig = console.error;
    console.error = (m: string) => void errors.push(m);
    try {
      const err = await storeUpload({ ...env, BUCKET: failing }, {
        workspaceId: WS,
        userId: s.alice.userId,
        name: 'x',
        declaredType: null,
        length: 10,
        body: streamOf(new Uint8Array(10)),
        now: 1_800_000_000_000,
      }).catch((e: unknown) => e);
      expect(err).toMatchObject({ status: 500, code: 'upload_failed' });
    } finally {
      console.error = orig;
    }
    expect(errors.some((m) => m.includes('r2_put_failed'))).toBe(true);
    expect(deleted).toHaveLength(1);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM files').first<{ n: number }>())?.n).toBe(0);

    const broken = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(10));
        c.error(new Error('client went away'));
      },
    });
    await expect(putExact(env.BUCKET, `ws/${WS}/01JBROKEN00000000000000000`, broken, 100)).rejects.toBeInstanceOf(UploadStreamError);
    expect(await fileKeys()).toEqual([]);
  });

  it('FILE_KEY_RE matches originals and thumbnails only, never emoji keys', () => {
    const id = '01JFILE0000000000000000000';
    const t = '01JTHUMB000000000000000000';
    expect(FILE_KEY_RE.test(fileKey(WS, id))).toBe(true);
    expect(FILE_KEY_RE.test(thumbKeyOf(WS, id, t))).toBe(true);
    expect(FILE_KEY_RE.test(`ws/${WS}/emoji/${id}`)).toBe(false);
    expect(FILE_KEY_RE.test(`${fileKey(WS, id)}-thumb`)).toBe(false);
    expect(FILE_KEY_RE.test(`${fileKey(WS, id)}/x`)).toBe(false);
  });

  it('non-members get 404', async () => {
    const s = await setup();
    await env.DB.prepare("INSERT OR IGNORE INTO workspaces (id, slug, name, created_at) VALUES ('01OTHERWS00000000000000000', 'other', 'Other', 1)").run();
    const res = await uploadFile(s.app, s.alice.cookie, text('x'), { slug: 'other' });
    expect(res.status).toBe(404);
    expect((await uploadFile(s.app, s.alice.cookie, text('x'), { slug: 'nope' })).status).toBe(404);
    expect((await uploadFile(s.app, '', text('x'))).status).toBe(401);

    const ctx = createExecutionContext();
    const noOrigin = await s.app.request(
      '/w/clubhack/files?name=x',
      { method: 'POST', headers: { Cookie: s.alice.cookie, 'Content-Length': '1' }, body: text('x') },
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(noOrigin.status).toBe(403);
    expect(await fileKeys()).toEqual([]);
  });
});

describe('thumbnail upload', () => {
  it('only the uploader, only raster originals, only small WebP, only once, only before attach', async () => {
    const s = await setup();
    const img = await created(await uploadFile(s.app, s.alice.cookie, png(2000, 1000), { name: 'big.png' }));

    const byBob = await postThumb(s.app, s.bob.cookie, img.id, webp(720, 360));
    expect(byBob.status).toBe(404);
    expect((await postThumb(s.app, s.alice.cookie, 'not-an-id', webp(720, 360))).status).toBe(404);
    expect((await postThumb(s.app, s.alice.cookie, '01JNOPE0000000000000000000', webp(720, 360))).status).toBe(404);

    const pngThumb = await postThumb(s.app, s.alice.cookie, img.id, png(720, 360));
    expect(pngThumb.status).toBe(400);
    expect(await errCode(pngThumb)).toBe('invalid_thumbnail');

    const wide = await postThumb(s.app, s.alice.cookie, img.id, webp(721, 300));
    expect(wide.status).toBe(400);
    expect(await errCode(wide)).toBe('invalid_thumbnail');

    const heavy = await postThumb(s.app, s.alice.cookie, img.id, webp(720, 360, 524_289));
    expect(heavy.status).toBe(413);
    expect(await errCode(heavy)).toBe('too_large');
    expect(await thumbKeys(img.id)).toEqual([]);

    const ok = await postThumb(s.app, s.alice.cookie, img.id, webp(720, 360));
    expect(ok.status).toBe(200);
    const file = ((await ok.json()) as { file: FileInfo }).file;
    expect(file).toEqual({ ...img, hasThumb: true });
    const live = await storedThumbKey(img.id);
    expect(live).toMatch(new RegExp(`^ws/${WS}/${img.id}-thumb-[0-9A-Z]{26}$`));
    expect(live).toMatch(FILE_KEY_RE);
    expect(await thumbKeys(img.id)).toEqual([live]);

    // P4-R20: one thumbnail per file.
    const again = await postThumb(s.app, s.alice.cookie, img.id, webp(100, 50));
    expect(again.status).toBe(409);
    expect(await errCode(again)).toBe('already_has_thumbnail');
    expect(await thumbKeys(img.id)).toEqual([live]);
    expect(await storedThumbKey(img.id)).toBe(live);

    const txt = await created(await uploadFile(s.app, s.alice.cookie, text('hi'), { name: 'a.txt', type: 'text/plain' }));
    const txtThumb = await postThumb(s.app, s.alice.cookie, txt.id, webp(10, 10));
    expect(txtThumb.status).toBe(400);
    expect(await errCode(txtThumb)).toBe('invalid_thumbnail');

    const img2 = await created(await uploadFile(s.app, s.alice.cookie, png(100, 100), { name: 'small.png' }));
    await env.DB.prepare("INSERT INTO message_files (message_id, file_id) VALUES ('01JMSG00000000000000000000', ?)").bind(img2.id).run();
    const attached = await postThumb(s.app, s.alice.cookie, img2.id, webp(100, 100));
    expect(attached.status).toBe(409);
    expect(await errCode(attached)).toBe('already_attached');
    expect(await thumbKeys(img2.id)).toEqual([]);
  });

  it('concurrent thumbnail posts: one wins, the live thumbnail is the winner\'s bytes, the loser leaves nothing', async () => {
    const s = await setup();
    const img = await created(await uploadFile(s.app, s.alice.cookie, png(2000, 1000), { name: 'big.png' }));
    const a = webp(720, 360, 2_000);
    const b = webp(100, 50, 1_000);
    const [ra, rb] = await Promise.all([postThumb(s.app, s.alice.cookie, img.id, a), postThumb(s.app, s.alice.cookie, img.id, b)]);
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    const loser = ra.status === 409 ? ra : rb;
    expect(await errCode(loser)).toBe('already_has_thumbnail');
    const live = await storedThumbKey(img.id);
    expect(await thumbKeys(img.id)).toEqual([live]);
    const obj = await env.BUCKET.get(live!);
    expect(new Uint8Array(await obj!.arrayBuffer())).toEqual(ra.status === 200 ? a : b);
  });

  it('the link UPDATE runs under waitUntil, so it completes even if the response is never delivered', async () => {
    const s = await setup();
    const img = await created(await uploadFile(s.app, s.alice.cookie, png(100, 100), { name: 'p.png' }));
    const { ctx, waited } = recordingCtx();
    const res = await s.app.request(
      `/files/${img.id}/thumb`,
      { method: 'POST', headers: { Origin: 'https://app.test', Cookie: s.alice.cookie }, body: webp(100, 100) },
      env,
      ctx,
    );
    expect(waited).toHaveLength(1);
    await Promise.all(waited);
    expect(await storedThumbKey(img.id)).not.toBeNull();
    expect(res.status).toBe(200);
  });

  it('insertFile stores objects under the real keys', async () => {
    const s = await setup();
    const id = await insertFile({ uploaderId: s.alice.userId, object: text('abc'), thumb: true, mime: 'image/png' });
    expect((await env.BUCKET.head(fileKey(WS, id)))?.size).toBe(3);
    const key = await storedThumbKey(id);
    expect(key).toMatch(FILE_KEY_RE);
    expect(await env.BUCKET.head(key!)).not.toBeNull();
    expect((await env.DB.prepare('SELECT size FROM files WHERE id = ?').bind(id).first())?.size).toBe(3);
  });
});
