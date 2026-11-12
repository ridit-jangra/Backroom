import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FileInfo } from '@backroom/protocol';
import { createApp } from '../src/app';
import { canDownload } from '../src/files/access';
import { deleteMessage, sendMessage } from '../src/messaging/store';
import { GENERAL, captureMailer, insertChannel, insertFile, png, resetDb, seedUsers, send, testDeps, uploadFile, webp } from './helpers';

beforeEach(resetDb);

const NOW = 1_800_000_000_000;
const WS = '01JCLUBHACK0000000000000WS';
const text = (s: string) => new TextEncoder().encode(s);

async function setup() {
  const { mailer, sent } = captureMailer();
  const app = createApp(testDeps({ mailer }));
  const [owner, alice, bob, carol] = await seedUsers(app, sent, ['owner@test.dev', 'alice@test.dev', 'bob@test.dev', 'carol@test.dev']);
  const P = await insertChannel({ name: 'p', kind: 'private', memberIds: [alice!.userId, bob!.userId] });
  const dmKey = [alice!.userId, bob!.userId].sort().join(':');
  const DM = await insertChannel({ name: null, kind: 'dm', memberIds: [alice!.userId, bob!.userId], dmKey });
  const ZOO = await insertChannel({ name: 'zoo', kind: 'public', memberIds: [alice!.userId] });

  const upload = async (cookie: string, name: string, bytes: Uint8Array, type = 'application/octet-stream'): Promise<FileInfo> => {
    const res = await uploadFile(app, cookie, bytes, { name, type });
    if (res.status !== 201) throw new Error(`upload failed: ${res.status}`);
    return ((await res.json()) as { file: FileInfo }).file;
  };
  const say = async (channelId: string, fileIds: string[], userId = alice!.userId, body = '') => {
    const r = await sendMessage(env.DB, {
      clientId: crypto.randomUUID(),
      channelId,
      userId,
      parentId: null,
      body,
      alsoInChannel: false,
      fileIds,
      now: NOW,
    });
    if (!r.ok) throw new Error(r.code);
    return r.message;
  };
  const get = async (path: string, cookie?: string, headers: Record<string, string> = {}) => {
    const ctx = createExecutionContext();
    const h: Record<string, string> = { ...headers };
    if (cookie) h.Cookie = cookie;
    const res = await app.request(path, { headers: h }, env, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  };
  return { app, owner: owner!, alice: alice!, bob: bob!, carol: carol!, P, DM, ZOO, upload, say, get };
}

async function errCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

const deactivateHere = (userId: string) =>
  env.DB.prepare('UPDATE workspace_members SET deactivated_at = 1 WHERE workspace_id = ? AND user_id = ?').bind(WS, userId).run();

const bytesOf = async (res: Response) => new Uint8Array(await res.arrayBuffer());

describe('canDownload', () => {
  const base = { role: 'member', uploaderId: 'U', messageId: 'M', deletedAt: null, kind: 'public' as const, isMember: null };
  it('requires an active role and, for attached files, a live visible message', () => {
    expect(canDownload(base, 'X')).toBe(true);
    expect(canDownload({ ...base, role: null }, 'X')).toBe(false);
    expect(canDownload({ ...base, deletedAt: 5 }, 'U')).toBe(false);
    expect(canDownload({ ...base, kind: 'private' }, 'X')).toBe(false);
    expect(canDownload({ ...base, kind: 'private', isMember: 1 }, 'X')).toBe(true);
    expect(canDownload({ ...base, kind: null }, 'X')).toBe(false);
    expect(canDownload({ ...base, messageId: null, kind: null }, 'U')).toBe(true);
    expect(canDownload({ ...base, messageId: null, kind: null }, 'X')).toBe(false);
    expect(canDownload({ ...base, messageId: null, kind: null, role: null }, 'U')).toBe(false);
  });
});

describe('file downloads', () => {
  it('uploader can fetch an unattached file; nobody else can', async () => {
    const s = await setup();
    const f = await s.upload(s.alice.cookie, 'notes.txt', text('hello'), 'text/plain');
    const ok = await s.get(`/files/${f.id}`, s.alice.cookie);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('hello');
    const hidden = await s.get(`/files/${f.id}`, s.bob.cookie);
    expect(hidden.status).toBe(404);
    const hiddenBody = await hidden.text();
    expect((await s.get(`/files/${f.id}`)).status).toBe(401);
    const unknown = await s.get('/files/01JNOSUCHFILE0000000000000', s.alice.cookie);
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toBe(hiddenBody);
    expect(JSON.parse(hiddenBody)).toEqual({ error: { code: 'not_found', message: 'File not found.' } });
    expect((await s.get('/files/not-an-id', s.alice.cookie)).status).toBe(404);
    expect((await s.get(`/files/${f.id}/thumb`, s.bob.cookie)).status).toBe(404);
  });

  it('channel visibility decides access', async () => {
    const s = await setup();
    const zoo = await s.upload(s.alice.cookie, 'zoo.txt', text('z'));
    const p = await s.upload(s.alice.cookie, 'p.txt', text('p'));
    const dm = await s.upload(s.alice.cookie, 'dm.txt', text('d'));
    await s.say(s.ZOO, [zoo.id]);
    await s.say(s.P, [p.id]);
    await s.say(s.DM, [dm.id]);

    expect((await s.get(`/files/${zoo.id}`, s.carol.cookie)).status).toBe(200);
    for (const f of [p, dm]) {
      expect((await s.get(`/files/${f.id}`, s.bob.cookie)).status).toBe(200);
      expect(await errCode(await s.get(`/files/${f.id}`, s.carol.cookie))).toBe('not_found');
    }

    // P4-R6: deactivation through the admin PATCH deletes the user's sessions ⇒ 401.
    const patch = await send(s.app, 'PATCH', `/w/clubhack/members/${s.carol.userId}`, { deactivated: true }, s.owner.cookie);
    expect(patch.status).toBe(200);
    expect((await s.get(`/files/${zoo.id}`, s.carol.cookie)).status).toBe(401);

    // A member deactivated here whose session survives (raw update; requireSession keeps sessions of users still
    // active in some workspace, so give them one) hits the role === null branch ⇒ 404.
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO workspaces (id, slug, name, created_at) VALUES ('01JOTHERWS0000000000000000', 'other', 'Other', 1)"),
      ...[s.alice.userId, s.bob.userId].map((u) =>
        env.DB.prepare("INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES ('01JOTHERWS0000000000000000', ?, 'member', 1)").bind(u),
      ),
    ]);
    await deactivateHere(s.bob.userId);
    for (const f of [zoo, p, dm]) expect((await s.get(`/files/${f.id}`, s.bob.cookie)).status).toBe(404);
    // ... and that includes the uploader's own unattached files.
    await deactivateHere(s.alice.userId);
    const own = await insertFile({ uploaderId: s.alice.userId, object: text('o') });
    expect((await s.get(`/files/${own}`, s.alice.cookie)).status).toBe(404);
  });

  it('access follows message visibility live', async () => {
    const s = await setup();
    const p = await s.upload(s.alice.cookie, 'p.txt', text('p'));
    const g = await s.upload(s.alice.cookie, 'g.txt', text('g'));
    await s.say(s.P, [p.id]);
    const gm = await s.say(GENERAL, [g.id]);

    expect((await s.get(`/files/${p.id}`, s.bob.cookie)).status).toBe(200);
    expect((await send(s.app, 'POST', `/channels/${s.P}/leave`, undefined, s.bob.cookie)).status).toBe(200);
    expect((await s.get(`/files/${p.id}`, s.bob.cookie)).status).toBe(404);

    expect((await s.get(`/files/${g.id}`, s.bob.cookie)).status).toBe(200);
    expect((await s.get(`/files/${g.id}`, s.carol.cookie)).status).toBe(200);
    const del = await deleteMessage(env.DB, { messageId: gm.id, userId: s.alice.userId, now: NOW + 1 });
    expect(del.ok).toBe(true);
    expect((await s.get(`/files/${g.id}`, s.bob.cookie)).status).toBe(404);
    expect((await s.get(`/files/${g.id}`, s.carol.cookie)).status).toBe(404);
    const own = await s.get(`/files/${g.id}`, s.alice.cookie);
    expect(own.status).toBe(200);
    expect(await own.text()).toBe('g');
  });

  it('inline vs attachment', async () => {
    const s = await setup();
    const cat = await s.upload(s.alice.cookie, 'cat.png', png(4, 3, 64), 'image/png');
    const pdf = await s.upload(s.alice.cookie, 'doc.pdf', text('%PDF-1.7 hello'), 'application/pdf');
    const mp4 = await s.upload(s.alice.cookie, 'clip.mp4', new Uint8Array(32), 'video/mp4');
    const txt = await s.upload(s.alice.cookie, 'notes.txt', text('plain'), 'text/plain');
    const cases: [FileInfo, string, string, number][] = [
      [cat, 'image/png', `inline; filename="cat.png"; filename*=UTF-8''cat.png`, 64],
      [pdf, 'application/pdf', `inline; filename="doc.pdf"; filename*=UTF-8''doc.pdf`, 14],
      [mp4, 'video/mp4', `inline; filename="clip.mp4"; filename*=UTF-8''clip.mp4`, 32],
      [txt, 'application/octet-stream', `attachment; filename="notes.txt"; filename*=UTF-8''notes.txt`, 5],
    ];
    for (const [f, type, disposition, size] of cases) {
      const res = await s.get(`/files/${f.id}`, s.alice.cookie);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe(type);
      expect(res.headers.get('Content-Disposition')).toBe(disposition);
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(res.headers.get('Content-Security-Policy')).toBe("default-src 'none'; sandbox");
      expect(res.headers.get('Cache-Control')).toBe('private, max-age=31536000, immutable');
      expect(res.headers.get('Accept-Ranges')).toBe('bytes');
      expect(res.headers.get('ETag')).toMatch(/^".+"$/);
      expect(res.headers.get('Content-Length')).toBe(String(size));
      expect((await bytesOf(res)).length).toBe(size);
    }
  });

  it('hostile types and names are served inert', async () => {
    const s = await setup();
    const body = text('<html><script>alert(1)</script>');
    const f = await s.upload(s.alice.cookie, 'résumé "final"\r\nSet-Cookie: a=b.svg', body, 'image/png');
    const res = await s.get(`/files/${f.id}`, s.alice.cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(res.headers.get('Content-Disposition')).toBe(
      `attachment; filename="r_sum_ _final_Set-Cookie: a=b.svg"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22final%22Set-Cookie%3A%20a%3Db.svg`,
    );
    for (const [, v] of res.headers) expect(v).not.toMatch(/[\r\n]/);
    expect(res.headers.get('Set-Cookie')).toBeNull();
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy')).toBe("default-src 'none'; sandbox");
    expect(await bytesOf(res)).toEqual(body);
  });

  it('Range requests', async () => {
    const s = await setup();
    const data = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);
    const f = await s.upload(s.alice.cookie, 'clip.mp4', data, 'video/mp4');
    const range = (r: string, extra: Record<string, string> = {}) => s.get(`/files/${f.id}`, s.alice.cookie, { Range: r, ...extra });

    const first = await range('bytes=0-99');
    expect(first.status).toBe(206);
    expect(first.headers.get('Content-Range')).toBe('bytes 0-99/1000');
    expect(first.headers.get('Content-Length')).toBe('100');
    expect(first.headers.get('Content-Type')).toBe('video/mp4');
    expect(first.headers.get('ETag')).toMatch(/^".+"$/);
    expect(await bytesOf(first)).toEqual(data.slice(0, 100));

    const suffix = await range('bytes=-10');
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get('Content-Range')).toBe('bytes 990-999/1000');
    expect(await bytesOf(suffix)).toEqual(data.slice(990));

    const open = await range('bytes=500-');
    expect(open.status).toBe(206);
    expect(open.headers.get('Content-Range')).toBe('bytes 500-999/1000');
    expect(await bytesOf(open)).toEqual(data.slice(500));

    const past = await range('bytes=1000-');
    expect(past.status).toBe(416);
    expect(past.headers.get('Content-Range')).toBe('bytes */1000');

    for (const res of [await range('bytes=0-1,5-6'), await range('bytes=0-9', { 'If-Range': '"x"' })]) {
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Range')).toBeNull();
      expect(res.headers.get('Content-Length')).toBe('1000');
      expect(await bytesOf(res)).toEqual(data);
    }
  });

  it('If-None-Match returns 304 with no body', async () => {
    const s = await setup();
    const f = await s.upload(s.alice.cookie, 'cat.png', png(4, 3), 'image/png');
    const first = await s.get(`/files/${f.id}`, s.alice.cookie);
    const etag = first.headers.get('ETag')!;
    await first.arrayBuffer();
    const again = await s.get(`/files/${f.id}`, s.alice.cookie, { 'If-None-Match': etag });
    expect(again.status).toBe(304);
    expect(again.headers.get('ETag')).toBe(etag);
    expect(again.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(await again.text()).toBe('');
    // A different or malformed validator never 500s: the full file is served.
    for (const inm of ['"other"', 'garbage"']) {
      const res = await s.get(`/files/${f.id}`, s.alice.cookie, { 'If-None-Match': inm });
      expect(res.status).toBe(200);
      expect((await bytesOf(res)).length).toBe(f.size);
    }
    // Visibility is checked before the conditional: a stranger with the etag still gets 404.
    expect((await s.get(`/files/${f.id}`, s.bob.cookie, { 'If-None-Match': etag })).status).toBe(404);
  });

  it('thumbnails share the file’s access', async () => {
    const s = await setup();
    const f = await s.upload(s.alice.cookie, 'cat.png', png(1000, 800), 'image/png');
    expect(await errCode(await s.get(`/files/${f.id}/thumb`, s.alice.cookie))).toBe('not_found');

    const thumb = webp(720, 576, 300);
    const ctx = createExecutionContext();
    const posted = await s.app.request(
      `/files/${f.id}/thumb`,
      { method: 'POST', headers: { Origin: 'https://app.test', Cookie: s.alice.cookie, 'Content-Type': 'image/webp' }, body: thumb },
      env,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(posted.status).toBe(200);
    expect((await s.get(`/files/${f.id}/thumb`, s.alice.cookie)).status).toBe(200);
    expect((await s.get(`/files/${f.id}/thumb`, s.bob.cookie)).status).toBe(404);

    await s.say(s.P, [f.id]);
    const res = await s.get(`/files/${f.id}/thumb`, s.bob.cookie, { Range: 'bytes=0-9' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/webp');
    expect(res.headers.get('Content-Disposition')).toBe(`inline; filename="thumbnail.webp"; filename*=UTF-8''thumbnail.webp`);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy')).toBe("default-src 'none'; sandbox");
    expect(res.headers.get('Content-Length')).toBe('300');
    expect(await bytesOf(res)).toEqual(thumb);
    const etag = res.headers.get('ETag')!;
    expect((await s.get(`/files/${f.id}/thumb`, s.bob.cookie, { 'If-None-Match': etag })).status).toBe(304);
    expect((await s.get(`/files/${f.id}/thumb`, s.carol.cookie)).status).toBe(404);
  });

  it('a missing R2 object is 404', async () => {
    const s = await setup();
    const id = await insertFile({ uploaderId: s.alice.userId, name: 'gone.txt', mime: 'text/plain', size: 5 });
    expect(await errCode(await s.get(`/files/${id}`, s.alice.cookie))).toBe('not_found');
    const m = await s.say(GENERAL, [], s.alice.userId, 'raw attach');
    await env.DB.prepare('INSERT INTO message_files (message_id, file_id) VALUES (?, ?)').bind(m.id, id).run();
    const res = await s.get(`/files/${id}`, s.bob.cookie);
    expect(res.status).toBe(404);
    expect(await errCode(res)).toBe('not_found');
  });
});
