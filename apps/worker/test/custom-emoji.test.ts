import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CustomEmoji } from '@backroom/protocol';
import type { Hono } from 'hono';
import type { AppEnv } from '../src/app';
import { createApp } from '../src/app';
import { readSettings } from '../src/emoji/custom';
import {
  blobHead,
  blobKeys,
  blobPut,
  captureMailer,
  describeBackends,
  env,
  gif,
  insertCustomEmoji,
  jpeg,
  patchBlobBinding,
  png,
  resetDb,
  send,
  seedUsers,
  testDeps,
  uploadEmoji,
} from './helpers';
import { CLUBHACK_WS, closeAll, connect } from './ws';

beforeEach(resetDb);
afterEach(() => closeAll());

const PREFIX = `ws/${CLUBHACK_WS}/emoji/`;
const text = (s: string) => new TextEncoder().encode(s);

async function setup() {
  const { mailer, sent } = captureMailer();
  const app = createApp(testDeps({ mailer }));
  const [owner, alice] = await seedUsers(app, sent, ['owner@test.dev', 'alice@test.dev']);
  return { app, owner: owner!, alice: alice! };
}

async function errCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

async function created(res: Response): Promise<CustomEmoji> {
  expect(res.status).toBe(201);
  return ((await res.json()) as { emoji: CustomEmoji }).emoji;
}

async function getImage(app: Hono<AppEnv>, path: string, headers: Record<string, string> = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.request(path, { method: 'GET', headers }, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function objectCount(): Promise<number> {
  return (await blobKeys(PREFIX)).length;
}

describe('readSettings', () => {
  it('defaults to admins unless the JSON says everyone', () => {
    expect(readSettings(null)).toEqual({ customEmojiPolicy: 'admins' });
    expect(readSettings('{}')).toEqual({ customEmojiPolicy: 'admins' });
    expect(readSettings('not json')).toEqual({ customEmojiPolicy: 'admins' });
    expect(readSettings('null')).toEqual({ customEmojiPolicy: 'admins' });
    expect(readSettings('{"customEmojiPolicy":"weird"}')).toEqual({ customEmojiPolicy: 'admins' });
    expect(readSettings('{"customEmojiPolicy":"everyone"}')).toEqual({ customEmojiPolicy: 'everyone' });
  });
});

describeBackends('custom emoji', () => {
  it('owner uploads a 32×32 PNG', async () => {
    const s = await setup();
    const emoji = await created(await uploadEmoji(s.app, s.owner.cookie, 'partyparrot', png(32, 32)));
    expect(emoji).toMatchObject({ name: 'partyparrot', aliasFor: null, createdBy: s.owner.userId, createdAt: 1_800_000_000_000 });
    expect(emoji.url).toBe('/emoji/' + emoji.id);
    const obj = await blobHead(`ws/01JCLUBHACK0000000000000WS/emoji/${emoji.id}`);
    expect(obj?.contentType).toBe('image/png');
    const list = await send(s.app, 'GET', '/w/clubhack/emoji', undefined, s.owner.cookie);
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ emoji: [emoji] });
  });

  it('lists in name order; aliases have no url; non-members get 404', async () => {
    const s = await setup();
    await insertCustomEmoji({ name: 'zeta' });
    await insertCustomEmoji({ name: 'pp', aliasFor: 'alpha' });
    await insertCustomEmoji({ name: 'alpha' });
    await insertCustomEmoji({ name: 'other', workspaceId: '01OTHERWS00000000000000000' });
    const res = await send(s.app, 'GET', '/w/clubhack/emoji', undefined, s.alice.cookie);
    const { emoji } = (await res.json()) as { emoji: CustomEmoji[] };
    expect(emoji.map((e) => e.name)).toEqual(['alpha', 'pp', 'zeta']);
    expect(emoji[1]).toMatchObject({ url: null, aliasFor: 'alpha' });
    expect(emoji[0]!.url).toBe(`/emoji/${emoji[0]!.id}`);
    expect((await send(s.app, 'GET', '/w/nope/emoji', undefined, s.alice.cookie)).status).toBe(404);
    expect((await send(s.app, 'GET', '/w/clubhack/emoji')).status).toBe(401);
  });

  it('type comes from magic bytes; disguised SVG/HTML and bombs are rejected', async () => {
    const s = await setup();
    const svg = await uploadEmoji(s.app, s.owner.cookie, 'svg', text('<svg xmlns="http://www.w3.org/2000/svg"/>'), {
      filename: 'x.png',
      type: 'image/png',
    });
    expect(svg.status).toBe(400);
    expect(await errCode(svg)).toBe('unsupported_type');
    const html = await uploadEmoji(s.app, s.owner.cookie, 'html', text('<html><script>alert(1)</script></html>'), {
      filename: 'x.png',
      type: 'image/png',
    });
    expect(html.status).toBe(400);
    expect(await errCode(html)).toBe('unsupported_type');
    const bomb = await uploadEmoji(s.app, s.owner.cookie, 'bomb', png(20_000, 20_000, 1_024));
    expect(bomb.status).toBe(400);
    expect(await errCode(bomb)).toBe('too_big');
    expect(await objectCount()).toBe(0);

    const bytes = gif(32, 32);
    const emoji = await created(await uploadEmoji(s.app, s.owner.cookie, 'gifjpeg', bytes, { filename: 'x.jpg', type: 'image/jpeg' }));
    const img = await getImage(s.app, emoji.url!, { Cookie: s.owner.cookie });
    expect(img.status).toBe(200);
    expect(img.headers.get('Content-Type')).toBe('image/gif');
    expect(img.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(bytes);

    const j = await created(await uploadEmoji(s.app, s.owner.cookie, 'jpg', jpeg(64, 48), { filename: 'x.gif', type: 'image/gif' }));
    expect((await blobHead(PREFIX + j.id))?.contentType).toBe('image/jpeg');
  });

  it('size limits', async () => {
    const s = await setup();
    await created(await uploadEmoji(s.app, s.owner.cookie, 'exact', png(32, 32, 131_072)));
    const over = await uploadEmoji(s.app, s.owner.cookie, 'over', png(32, 32, 131_073));
    expect(over.status).toBe(413);
    expect(await errCode(over)).toBe('too_large');
    const small = await uploadEmoji(s.app, s.owner.cookie, 'small', png(31, 32));
    expect(small.status).toBe(400);
    expect(await errCode(small)).toBe('too_small');
    const tall = await uploadEmoji(s.app, s.owner.cookie, 'tall', png(32, 4_097));
    expect(await errCode(tall)).toBe('too_big');
    await created(await uploadEmoji(s.app, s.owner.cookie, 'max', png(4_096, 4_096)));
  });

  it('rejects bodies over the upload limit before parsing them', async () => {
    const s = await setup();
    const big = new Uint8Array(200_000);
    big.set(png(32, 32));
    // Declared Content-Length over the limit.
    const ctx = createExecutionContext();
    const declared = await s.app.request(
      '/w/clubhack/emoji',
      {
        method: 'POST',
        headers: { Origin: 'https://app.test', Cookie: s.owner.cookie, 'Content-Type': 'multipart/form-data; boundary=x', 'Content-Length': '200000' },
        body: big,
      },
      env,
      ctx,
    );
    expect(declared.status).toBe(413);
    expect(await errCode(declared)).toBe('too_large');
    // A streamed body without Content-Length is cut off at the limit too.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 4; i++) controller.enqueue(new Uint8Array(50_000));
        controller.close();
      },
    });
    const streamed = await s.app.request(
      '/w/clubhack/emoji',
      {
        method: 'POST',
        headers: { Origin: 'https://app.test', Cookie: s.owner.cookie, 'Content-Type': 'multipart/form-data; boundary=x' },
        body: stream,
        // @ts-expect-error duplex is required for stream bodies but missing from the RequestInit type
        duplex: 'half',
      },
      env,
      createExecutionContext(),
    );
    expect(streamed.status).toBe(413);
    // Not multipart at all.
    const bad = await send(s.app, 'POST', '/w/clubhack/emoji', { name: 'x' }, s.owner.cookie);
    expect(bad.status).toBe(400);
    expect(await errCode(bad)).toBe('invalid_request');
  });

  it('name rules', async () => {
    const s = await setup();
    const upper = await uploadEmoji(s.app, s.owner.cookie, 'Party', png(32, 32));
    expect(upper.status).toBe(400);
    expect(await errCode(upper)).toBe('invalid_name');
    const long = await uploadEmoji(s.app, s.owner.cookie, 'a'.repeat(33), png(32, 32));
    expect(long.status).toBe(400);
    expect(await errCode(long)).toBe('invalid_name');
    for (const name of ['smile', 'thumbsup']) {
      const res = await uploadEmoji(s.app, s.owner.cookie, name, png(32, 32));
      expect(res.status).toBe(409);
      expect(await errCode(res)).toBe('name_taken');
    }
    await created(await uploadEmoji(s.app, s.owner.cookie, 'partyparrot', png(32, 32)));
    const dup = await uploadEmoji(s.app, s.owner.cookie, 'partyparrot', gif(40, 40));
    expect(dup.status).toBe(409);
    expect(await errCode(dup)).toBe('name_taken');
    expect(await objectCount()).toBe(1);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM custom_emoji WHERE name = 'partyparrot'").first<{ n: number }>();
    expect(n!.n).toBe(1);
  });

  it('missing image is invalid_request', async () => {
    const s = await setup();
    const form = new FormData();
    form.set('name', 'noimage');
    form.set('image', 'not a file');
    const ctx = createExecutionContext();
    const res = await s.app.request(
      '/w/clubhack/emoji',
      { method: 'POST', headers: { Origin: 'https://app.test', Cookie: s.owner.cookie }, body: form },
      env,
      ctx,
    );
    expect(res.status).toBe(400);
    expect(await errCode(res)).toBe('invalid_request');
  });

  it('members cannot add by default', async () => {
    const s = await setup();
    const res = await uploadEmoji(s.app, s.alice.cookie, 'mine', png(32, 32));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: 'forbidden', message: 'Only admins can add custom emoji in this workspace.' },
    });
    await env.DB.prepare(`UPDATE workspaces SET settings_json = '{"customEmojiPolicy":"everyone"}' WHERE id = ?`).bind(CLUBHACK_WS).run();
    await created(await uploadEmoji(s.app, s.alice.cookie, 'mine', png(32, 32)));
    // Non-members of the slug get 404, not 403; no Origin is 403 bad_origin.
    expect((await send(s.app, 'POST', '/w/nope/emoji', {}, s.owner.cookie)).status).toBe(404);
  });

  it('limit_reached at 2,000', async () => {
    const s = await setup();
    const stmt = env.DB.prepare(
      "INSERT INTO custom_emoji (id, workspace_id, name, r2_key, alias_for, created_by, created_at) VALUES (?, ?, ?, 'k', NULL, NULL, 1)",
    );
    const rows = Array.from({ length: 2_000 }, (_, i) => stmt.bind(`ID${String(i).padStart(24, '0')}`, CLUBHACK_WS, `e${i}`));
    for (let i = 0; i < rows.length; i += 500) await env.DB.batch(rows.slice(i, i + 500));
    const res = await uploadEmoji(s.app, s.owner.cookie, 'onemore', png(32, 32));
    expect(res.status).toBe(400);
    expect(await errCode(res)).toBe('limit_reached');
    expect(await objectCount()).toBe(0);
  });

  it('serving headers and access', async () => {
    const s = await setup();
    const bytes = png(32, 32, 500);
    bytes[400] = 7;
    const emoji = await created(await uploadEmoji(s.app, s.owner.cookie, 'served', bytes));
    const res = await getImage(s.app, `/emoji/${emoji.id}`, { Cookie: s.alice.cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=31536000, immutable');
    expect(res.headers.get('Content-Security-Policy')).toBe("default-src 'none'; sandbox");
    const etag = res.headers.get('ETag');
    expect(etag).toBeTruthy();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);

    const cached = await getImage(s.app, `/emoji/${emoji.id}`, { Cookie: s.alice.cookie, 'If-None-Match': etag! });
    expect(cached.status).toBe(304);
    expect(cached.headers.get('ETag')).toBe(etag);
    expect(await cached.text()).toBe('');
    const stale = await getImage(s.app, `/emoji/${emoji.id}`, { Cookie: s.alice.cookie, 'If-None-Match': '"nope"' });
    expect(stale.status).toBe(200);
    await stale.arrayBuffer();

    expect((await getImage(s.app, `/emoji/${emoji.id}`)).status).toBe(401);

    const otherId = await insertCustomEmoji({ name: 'theirs', workspaceId: '01OTHERWS00000000000000000' });
    await blobPut(`ws/01OTHERWS00000000000000000/emoji/${otherId}`, png(32, 32), 'image/png');
    const other = await getImage(s.app, `/emoji/${otherId}`, { Cookie: s.alice.cookie });
    expect(other.status).toBe(404);
    expect(await errCode(other)).toBe('not_found');

    const aliasId = await insertCustomEmoji({ name: 'srv', aliasFor: 'served' });
    expect((await getImage(s.app, `/emoji/${aliasId}`, { Cookie: s.alice.cookie })).status).toBe(404);

    // Row exists but the object has not arrived (KV propagation, P6-R8): 503 blob_pending, never cached.
    const orphan = await insertCustomEmoji({ name: 'orphan' });
    const pending = await getImage(s.app, `/emoji/${orphan}`, { Cookie: s.alice.cookie });
    expect(pending.status).toBe(503);
    expect(pending.headers.get('Retry-After')).toBe('5');
    expect(pending.headers.get('Cache-Control')).toBe('no-store');
    expect(await pending.json()).toEqual({
      error: { code: 'blob_pending', message: 'This file is still syncing. Try again in a few seconds.' },
    });
    // Unknown and malformed ids stay the identical 404 (as does another workspace's emoji, above).
    expect((await getImage(s.app, '/emoji/01AAAAAAAAAAAAAAAAAAAAAAAA', { Cookie: s.alice.cookie })).status).toBe(404);
    expect((await getImage(s.app, '/emoji/..%2F..%2Fx', { Cookie: s.alice.cookie })).status).toBe(404);

    // A deactivated member loses access (their session no longer resolves).
    await env.DB.prepare('UPDATE workspace_members SET deactivated_at = 1 WHERE user_id = ?').bind(s.alice.userId).run();
    expect((await getImage(s.app, `/emoji/${emoji.id}`, { Cookie: s.alice.cookie })).status).toBe(401);
  });

  it('upload broadcasts emoji.update', async () => {
    const s = await setup();
    const sock = await connect(s.app, s.alice.cookie);
    const emoji = await created(await uploadEmoji(s.app, s.owner.cookie, 'live', png(32, 32)));
    const f = await sock.next('emoji.update');
    expect(f.added[0]!.name).toBe('live');
    expect(f.added).toEqual([emoji]);
    expect(f.removed).toEqual([]);
  });
});

describeBackends('custom emoji aliases, delete, policy', () => {
  async function setup3() {
    const { mailer, sent } = captureMailer();
    const app = createApp(testDeps({ mailer }));
    const [owner, alice, bob] = await seedUsers(app, sent, ['owner@test.dev', 'alice@test.dev', 'bob@test.dev']);
    const r = await send(app, 'PATCH', `/w/clubhack/members/${bob!.userId}`, { role: 'admin' }, owner!.cookie);
    expect(r.status).toBe(200);
    return { app, owner: owner!, alice: alice!, bob: bob! };
  }
  const setEveryone = () =>
    env.DB.prepare(`UPDATE workspaces SET settings_json = '{"customEmojiPolicy":"everyone"}' WHERE id = ?`).bind(CLUBHACK_WS).run();

  it('alias to a built-in and to a custom emoji', async () => {
    const s = await setup3();
    const a = await created(await send(s.app, 'POST', '/w/clubhack/emoji', { name: 'yay', aliasFor: 'tada' }, s.owner.cookie));
    expect(a).toMatchObject({ name: 'yay', url: null, aliasFor: 'tada' });
    const b = await created(await send(s.app, 'POST', '/w/clubhack/emoji', { name: 'likes', aliasFor: 'thumbsup' }, s.owner.cookie));
    expect(b.aliasFor).toBe('+1');
    await created(await uploadEmoji(s.app, s.owner.cookie, 'partyparrot', png(32, 32)));
    const c = await created(await send(s.app, 'POST', '/w/clubhack/emoji', { name: 'pp', aliasFor: 'partyparrot' }, s.owner.cookie));
    expect(c).toMatchObject({ url: null, aliasFor: 'partyparrot' });
  });

  it('alias errors', async () => {
    const s = await setup3();
    const post = (body: unknown) => send(s.app, 'POST', '/w/clubhack/emoji', body, s.owner.cookie);
    const r1 = await post({ name: 'x1', aliasFor: 'nope' });
    expect(r1.status).toBe(400);
    expect(await errCode(r1)).toBe('invalid_alias');
    await created(await uploadEmoji(s.app, s.owner.cookie, 'partyparrot', png(32, 32)));
    await created(await post({ name: 'pp', aliasFor: 'partyparrot' }));
    const r2 = await post({ name: 'x2', aliasFor: 'pp' });
    expect(r2.status).toBe(400);
    expect(await errCode(r2)).toBe('invalid_alias');
    expect((await post({ name: 'smile', aliasFor: 'tada' })).status).toBe(409);
    expect((await send(s.app, 'POST', '/w/clubhack/emoji', { name: 'zz', aliasFor: 'tada' }, s.alice.cookie)).status).toBe(403);
  });

  it('delete permissions', async () => {
    const s = await setup3();
    await setEveryone();
    const a1 = await created(await uploadEmoji(s.app, s.alice.cookie, 'a1', png(32, 32)));
    const a2 = await created(await uploadEmoji(s.app, s.alice.cookie, 'a2', png(32, 32)));
    const o1 = await created(await uploadEmoji(s.app, s.owner.cookie, 'o1', png(32, 32)));
    const del = (id: string, cookie: string) => send(s.app, 'DELETE', `/emoji/${id}`, undefined, cookie);
    const bobDel = await del(a1.id, s.bob.cookie);
    expect(bobDel.status).toBe(200);
    expect(await bobDel.json()).toEqual({ ok: true });
    expect((await del(a2.id, s.alice.cookie)).status).toBe(200);
    expect((await del(o1.id, s.alice.cookie)).status).toBe(403);
    expect((await del('01ARZ3NDEKTSV4RRFFQ69G5FAV', s.alice.cookie)).status).toBe(404);
    expect((await del('bad', s.alice.cookie)).status).toBe(404);
  });

  it('delete cascades aliases, removes the stored object and broadcasts removed ids', async () => {
    const s = await setup3();
    const pp = await created(await uploadEmoji(s.app, s.owner.cookie, 'partyparrot', png(32, 32)));
    const alias = await created(await send(s.app, 'POST', '/w/clubhack/emoji', { name: 'pp', aliasFor: 'partyparrot' }, s.owner.cookie));
    const keep = await created(await uploadEmoji(s.app, s.owner.cookie, 'keeper', png(32, 32)));
    const sock = await connect(s.app, s.alice.cookie);
    expect((await send(s.app, 'DELETE', `/emoji/${pp.id}`, undefined, s.owner.cookie)).status).toBe(200);
    const f = await sock.next('emoji.update');
    expect(f.added).toEqual([]);
    expect([...f.removed].sort()).toEqual([pp.id, alias.id].sort());
    expect(await blobHead(PREFIX + pp.id)).toBeNull();
    expect(await blobHead(PREFIX + keep.id)).not.toBeNull();
    const list = await send(s.app, 'GET', '/w/clubhack/emoji', undefined, s.owner.cookie);
    expect(((await list.json()) as { emoji: CustomEmoji[] }).emoji.map((e) => e.name)).toEqual(['keeper']);
  });

  it('delete cascade is scoped to the emoji workspace', async () => {
    const s = await setup3();
    const pp = await created(await uploadEmoji(s.app, s.owner.cookie, 'partyparrot', png(32, 32)));
    await env.DB.prepare("INSERT OR IGNORE INTO workspaces (id, slug, name, created_at) VALUES ('01OTHERWS00000000000000000', 'other', 'Other', 1)").run();
    const other = await insertCustomEmoji({ name: 'foreign', aliasFor: 'partyparrot', workspaceId: '01OTHERWS00000000000000000' });
    await send(s.app, 'DELETE', `/emoji/${pp.id}`, undefined, s.owner.cookie);
    const row = await env.DB.prepare('SELECT id FROM custom_emoji WHERE id = ?').bind(other).first();
    expect(row).not.toBeNull();
  });

  it('policy: owner switches to everyone, then members may upload', async () => {
    const s = await setup3();
    const patch = (body: unknown, cookie: string) => send(s.app, 'PATCH', '/w/clubhack/settings', body, cookie);
    expect((await patch({ customEmojiPolicy: 'everyone' }, s.alice.cookie)).status).toBe(403);
    expect((await patch({ customEmojiPolicy: 'everyone' }, s.bob.cookie)).status).toBe(403);
    const ok = await patch({ customEmojiPolicy: 'everyone' }, s.owner.cookie);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ settings: { customEmojiPolicy: 'everyone' } });
    await created(await uploadEmoji(s.app, s.alice.cookie, 'mine', png(32, 32)));
    expect((await patch({ customEmojiPolicy: 'all' }, s.owner.cookie)).status).toBe(400);
  });

  it('storage cleanup failure does not mask name_taken; malformed If-None-Match is 200', async () => {
    const s = await setup3();
    const e = await created(await uploadEmoji(s.app, s.owner.cookie, 'dup', png(32, 32)));
    const restore = patchBlobBinding(() => ({ delete: (() => Promise.reject(new Error('storage down'))) as never }));
    try {
      const res = await uploadEmoji(s.app, s.owner.cookie, 'dup', png(32, 32));
      expect(res.status).toBe(409);
      expect(await errCode(res)).toBe('name_taken');
    } finally {
      restore();
    }
    const img = await getImage(s.app, `/emoji/${e.id}`, { Cookie: s.owner.cookie, 'If-None-Match': 'abc' });
    expect(img.status).toBe(200);
    await img.arrayBuffer();
  });
});

describeBackends('emojiRev (P3-R20) and final-review fixes', () => {
  const rev = async () =>
    (await env.DB.prepare("SELECT json_extract(settings_json, '$.emojiRev') AS r FROM workspaces WHERE id = ?").bind(CLUBHACK_WS).first<{ r: number | null }>())!.r ?? 0;
  const boot = async (app: Hono<AppEnv>, cookie: string, q = '') =>
    (await (await send(app, 'GET', `/w/clubhack/bootstrap${q}`, undefined, cookie)).json()) as { customEmoji?: CustomEmoji[]; emojiRev?: number };

  it('rev bumps on upload, alias and delete, but not on a failed insert', async () => {
    const s = await setup();
    expect(await rev()).toBe(0);
    const e = await created(await uploadEmoji(s.app, s.owner.cookie, 'partyparrot', png(32, 32)));
    expect(await rev()).toBe(1);
    await created(await send(s.app, 'POST', '/w/clubhack/emoji', { name: 'pp', aliasFor: 'partyparrot' }, s.owner.cookie));
    expect(await rev()).toBe(2);
    expect((await send(s.app, 'POST', '/w/clubhack/emoji', { name: 'x1', aliasFor: 'nope' }, s.owner.cookie)).status).toBe(400);
    expect((await send(s.app, 'POST', '/w/clubhack/emoji', { name: 'pp', aliasFor: 'tada' }, s.owner.cookie)).status).toBe(409);
    expect(await rev()).toBe(2);
    expect((await send(s.app, 'DELETE', `/emoji/${e.id}`, undefined, s.owner.cookie)).status).toBe(200);
    expect(await rev()).toBe(3);
  });

  it('rev bump keeps other settings and repairs corrupt settings JSON', async () => {
    const s = await setup();
    await env.DB.prepare(`UPDATE workspaces SET settings_json = '{"customEmojiPolicy":"everyone"}' WHERE id = ?`).bind(CLUBHACK_WS).run();
    await created(await uploadEmoji(s.app, s.alice.cookie, 'mine', png(32, 32)));
    const row = await env.DB.prepare('SELECT settings_json AS j FROM workspaces WHERE id = ?').bind(CLUBHACK_WS).first<{ j: string }>();
    expect(JSON.parse(row!.j)).toEqual({ customEmojiPolicy: 'everyone', emojiRev: 1 });
    await env.DB.prepare(`UPDATE workspaces SET settings_json = '{oops' WHERE id = ?`).bind(CLUBHACK_WS).run();
    expect((await boot(s.app, s.owner.cookie)).emojiRev).toBe(0);
    await created(await send(s.app, 'POST', '/w/clubhack/emoji', { name: 'yay', aliasFor: 'tada' }, s.owner.cookie));
    expect(await rev()).toBe(1);
  });

  it('bootstrap omits customEmoji only when ?emojiRev matches', async () => {
    const s = await setup();
    await created(await uploadEmoji(s.app, s.owner.cookie, 'partyparrot', png(32, 32)));
    const first = await boot(s.app, s.owner.cookie);
    expect(first.emojiRev).toBe(1);
    expect(first.customEmoji?.map((e) => e.name)).toEqual(['partyparrot']);
    const same = await boot(s.app, s.owner.cookie, '?emojiRev=1');
    expect(same.emojiRev).toBe(1);
    expect(same).not.toHaveProperty('customEmoji');
    const stale = await boot(s.app, s.owner.cookie, '?emojiRev=0');
    expect(stale.customEmoji?.map((e) => e.name)).toEqual(['partyparrot']);
    const junk = await boot(s.app, s.owner.cookie, '?emojiRev=abc');
    expect(junk.customEmoji).toHaveLength(1);
    await created(await send(s.app, 'POST', '/w/clubhack/emoji', { name: 'pp', aliasFor: 'partyparrot' }, s.owner.cookie));
    const after = await boot(s.app, s.owner.cookie, '?emojiRev=1');
    expect(after.emojiRev).toBe(2);
    expect(after.customEmoji?.map((e) => e.name)).toEqual(['partyparrot', 'pp']);
  });

  it('an empty workspace with matching rev 0 omits the (empty) list', async () => {
    const s = await setup();
    const b = await boot(s.app, s.owner.cookie, '?emojiRev=0');
    expect(b.emojiRev).toBe(0);
    expect(b).not.toHaveProperty('customEmoji');
  });

  it('duplicate upload name is 409 before any storage put', async () => {
    const s = await setup();
    await created(await uploadEmoji(s.app, s.owner.cookie, 'dup', png(32, 32)));
    let puts = 0;
    const restore = patchBlobBinding((real) => ({
      put: ((...args: never[]) => {
        puts++;
        return real.put(...args);
      }) as never,
    }));
    try {
      const res = await uploadEmoji(s.app, s.owner.cookie, 'dup', png(32, 32));
      expect(res.status).toBe(409);
      expect(await errCode(res)).toBe('name_taken');
      expect(puts).toBe(0);
    } finally {
      restore();
    }
    expect(await objectCount()).toBe(1);
  });

  it('PATCH settings survives corrupt stored settings JSON', async () => {
    const s = await setup();
    await env.DB.prepare(`UPDATE workspaces SET settings_json = 'not json' WHERE id = ?`).bind(CLUBHACK_WS).run();
    const res = await send(s.app, 'PATCH', '/w/clubhack/settings', { customEmojiPolicy: 'everyone' }, s.owner.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ settings: { customEmojiPolicy: 'everyone' } });
  });
});
