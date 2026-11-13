import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FileInfo, SearchHit, SearchPage } from '@backroom/protocol';
import { createApp } from '../src/app';
import { deleteMessage, sendMessage } from '../src/messaging/store';
import { newId } from '../src/lib/ids';
import { HIT_END, HIT_START, buildSearchSql, decodeCursor, encodeCursor, splitSnippet } from '../src/search/search';
import { GENERAL, captureMailer, insertChannel, resetDb, seedUsers, send, testDeps, uploadFile } from './helpers';

beforeEach(resetDb);

const NOW = 1_800_000_000_000; // testDeps().now()
const DAY = 86_400_000;
const WS = '01JCLUBHACK0000000000000WS';
const OTHER_WS = '01JOTHERWS0000000000000000';

async function setup() {
  const { mailer, sent } = captureMailer();
  const app = createApp(testDeps({ mailer }));
  const [owner, alice, bob, carol] = await seedUsers(app, sent, ['owner@test.dev', 'alice@test.dev', 'bob@test.dev', 'carol@test.dev']);

  const say = async (channelId: string, body: string, opts: { userId?: string; now?: number; fileIds?: string[] } = {}) => {
    const r = await sendMessage(env.DB, {
      clientId: crypto.randomUUID(),
      channelId,
      userId: opts.userId ?? alice!.userId,
      parentId: null,
      body,
      alsoInChannel: false,
      fileIds: opts.fileIds ?? [],
      now: opts.now ?? NOW,
    });
    if (!r.ok) throw new Error(r.code);
    return r.message;
  };
  // 20 fillers without the search words, so bm25 IDF stays positive for them.
  for (let i = 0; i < 20; i++) await say(GENERAL, `filler ${i}`, { now: NOW - 100 * DAY + i });

  const upload = async (cookie: string, name: string): Promise<FileInfo> => {
    const res = await uploadFile(app, cookie, new TextEncoder().encode('x'), { name, type: 'application/pdf' });
    if (res.status !== 201) throw new Error(`upload failed: ${res.status}`);
    return ((await res.json()) as { file: FileInfo }).file;
  };
  const raw = async (cookie: string, query: string, cursor?: string) => {
    const params = new URLSearchParams({ q: query });
    if (cursor !== undefined) params.set('cursor', cursor);
    const ctx = createExecutionContext();
    const res = await app.request(`/w/clubhack/search?${params}`, { headers: { Cookie: cookie } }, env, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  };
  const q = async (cookie: string, query: string, cursor?: string): Promise<SearchPage> => {
    const res = await raw(cookie, query, cursor);
    if (res.status !== 200) throw new Error(`search ${JSON.stringify(query)} failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as SearchPage;
  };
  const ids = (p: SearchPage) => p.results.map((r) => r.message.id);
  const chans = (p: SearchPage) => p.results.map((r) => r.channel.id).sort();
  return { app, owner: owner!, alice: alice!, bob: bob!, carol: carol!, say, upload, raw, q, ids, chans };
}

async function errCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

const join = (h: SearchHit) => h.snippet.map((s) => s.text).join('');

describe('search cost cap (P4-R24)', () => {
  it('uses only the first 8 terms and lists the rest as ignoredTerms', async () => {
    const s = await setup();
    const hit = await s.say(GENERAL, 'alpha bravo charlie delta echo foxtrot golf hotel');
    const q = 'alpha bravo charlie delta echo foxtrot golf hotel india "juliet kilo"';
    const page = await s.q(s.carol.cookie, q);
    // india and "juliet kilo" are not in the message: had they been matched, there would be no hit
    expect(s.ids(page)).toEqual([hit.id]);
    expect(page.ignoredTerms).toEqual(['india', 'juliet kilo']);
  });

  it('filters do not count as terms; ignoredTerms is omitted when nothing was dropped', async () => {
    const s = await setup();
    const hit = await s.say(GENERAL, 'alpha bravo charlie delta echo foxtrot golf hotel');
    const page = await s.q(s.carol.cookie, 'in:#general from:alice alpha bravo charlie delta echo foxtrot golf hotel');
    expect(s.ids(page)).toEqual([hit.id]);
    expect('ignoredTerms' in page).toBe(false);
  });
});

describe('search helpers', () => {
  it('splitSnippet marks hits, drops empties and keeps unbalanced markers as text', () => {
    expect(splitSnippet(`a ${HIT_START}zebra${HIT_END} b`)).toEqual([
      { text: 'a ', hit: false },
      { text: 'zebra', hit: true },
      { text: ' b', hit: false },
    ]);
    expect(splitSnippet(`${HIT_START}x${HIT_END}${HIT_START}${HIT_END}`)).toEqual([{ text: 'x', hit: true }]);
    expect(splitSnippet(`a${HIT_START}b`)).toEqual([{ text: `a${HIT_START}b`, hit: false }]);
    expect(splitSnippet(`a${HIT_END}b ${HIT_START}c${HIT_END}`)).toEqual([
      { text: `a${HIT_END}b `, hit: false },
      { text: 'c', hit: true },
    ]);
    expect(splitSnippet('')).toEqual([]);
  });

  it('cursors round-trip and reject anything off the grid', () => {
    expect(decodeCursor(encodeCursor(40, NOW))).toEqual({ o: 40, t: NOW });
    const b64 = (s: string) => btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    for (const bad of [
      b64('{"o":41,"t":1}'),
      b64('{"o":500,"t":1}'),
      b64('{"o":-20,"t":1}'),
      b64('{"o":20,"t":0}'),
      b64('{"o":20,"t":1.5}'),
      b64('{"o":"20","t":1}'),
      b64('[20,1]'),
      b64('null'),
      'not base64 !',
      '',
    ]) {
      expect(decodeCursor(bad)).toBeNull();
    }
  });
});

describe('search', () => {
  it('finds words, highlights them, and renders nothing as HTML', async () => {
    const s = await setup();
    await s.say(GENERAL, '<b>zebra</b> & stripes');
    const page = await s.q(s.carol.cookie, 'zebra');
    expect(page.results).toHaveLength(1);
    const hit = page.results[0]!;
    expect(hit.snippet).toContainEqual({ text: 'zebra', hit: true });
    expect(join(hit)).toContain('<b>');
    expect(hit.channel).toEqual({ id: GENERAL, name: 'general', kind: 'public', isMember: true });
    expect(page.nextCursor).toBeNull();
  });

  it('search never returns deleted or invisible messages', async () => {
    const s = await setup();
    const P = await insertChannel({ name: 'p', kind: 'private', memberIds: [s.alice.userId, s.bob.userId] });
    const dmKey = [s.alice.userId, s.bob.userId].sort().join(':');
    const DM = await insertChannel({ name: null, kind: 'dm', memberIds: [s.alice.userId, s.bob.userId], dmKey });
    const ZOO = await insertChannel({ name: 'zoo', kind: 'public', memberIds: [s.alice.userId, s.bob.userId] });
    await s.say(GENERAL, 'zebra in general');
    await s.say(P, 'zebra in private');
    await s.say(DM, 'zebra in dm');
    await s.say(ZOO, 'zebra in zoo');
    const gone = await s.say(GENERAL, 'zebra deleted soon');
    expect((await deleteMessage(env.DB, { messageId: gone.id, userId: s.alice.userId, now: NOW })).ok).toBe(true);
    // Another workspace's channel that bob is even a member of.
    const OTHER_CH = newId();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, 'other', 'Other', 1)").bind(OTHER_WS),
      env.DB.prepare("INSERT INTO channels (id, workspace_id, name, kind, created_at) VALUES (?, ?, 'general', 'public', 1)").bind(OTHER_CH, OTHER_WS),
      env.DB.prepare('INSERT INTO channel_members (channel_id, user_id, last_read_seq, joined_at) VALUES (?, ?, 0, 1)').bind(OTHER_CH, s.bob.userId),
      env.DB.prepare("INSERT INTO messages (id, channel_id, seq, user_id, body, created_at) VALUES (?, ?, 1, ?, 'zebra elsewhere', ?)").bind(newId(), OTHER_CH, s.bob.userId, NOW),
    ]);

    // ... with an attached file whose name matches.
    const otherMsg = newId();
    const otherFile = newId();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO messages (id, channel_id, seq, user_id, body, created_at) VALUES (?, ?, 2, ?, 'see file', ?)").bind(otherMsg, OTHER_CH, s.bob.userId, NOW),
      env.DB.prepare(
        "INSERT INTO files (id, workspace_id, uploader_id, r2_key, name, mime, size, created_at) VALUES (?, ?, ?, ?, 'zebra-plans.pdf', 'application/pdf', 1, ?)",
      ).bind(otherFile, OTHER_WS, s.bob.userId, `ws/${OTHER_WS}/${otherFile}`, NOW),
      env.DB.prepare('INSERT INTO message_files (message_id, file_id) VALUES (?, ?)').bind(otherMsg, otherFile),
    ]);
    expect((await s.q(s.bob.cookie, 'plans')).results).toEqual([]);

    const carol = await s.q(s.carol.cookie, 'zebra');
    expect(s.chans(carol)).toEqual([GENERAL, ZOO].sort());
    expect(carol.results.find((r) => r.channel.id === ZOO)!.channel).toEqual({ id: ZOO, name: 'zoo', kind: 'public', isMember: false });
    expect(carol.results.some((r) => r.message.id === gone.id)).toBe(false);

    const bob = await s.q(s.bob.cookie, 'zebra');
    expect(s.chans(bob)).toEqual([GENERAL, P, DM, ZOO].sort());
    expect(bob.results.find((r) => r.channel.id === DM)!.channel).toEqual({ id: DM, name: null, kind: 'dm', isMember: true });

    // Filter-only search follows the same rules.
    expect(s.chans(await s.q(s.carol.cookie, `from:@alice`)).every((c) => c === GENERAL || c === ZOO)).toBe(true);
    expect((await s.q(s.carol.cookie, 'in:#p')).results).toEqual([]);
    for (const f of ['from:@alice', 'in:#general']) {
      const page = await s.q(s.carol.cookie, f);
      expect(page.results.length, f).toBeGreaterThan(0);
      expect(page.results.some((r) => r.message.id === gone.id), f).toBe(false);
      expect(page.results.every((r) => r.message.deletedAt === null), f).toBe(true);
    }

    expect((await send(s.app, 'POST', `/channels/${P}/leave`, undefined, s.bob.cookie)).status).toBe(200);
    expect(s.chans(await s.q(s.bob.cookie, 'zebra'))).toEqual([GENERAL, DM, ZOO].sort());

    // P4-R6: deactivation through the admin PATCH deletes the user's sessions ⇒ 401.
    const patch = await send(s.app, 'PATCH', `/w/clubhack/members/${s.carol.userId}`, { deactivated: true }, s.owner.cookie);
    expect(patch.status).toBe(200);
    expect((await s.raw(s.carol.cookie, 'zebra')).status).toBe(401);

    // P4-R23: deactivated here but still active elsewhere, so the session survives ⇒ requireMember 404.
    await env.DB.prepare("INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, 'member', 1)")
      .bind(OTHER_WS, s.bob.userId)
      .run();
    await env.DB.prepare('UPDATE workspace_members SET deactivated_at = 1 WHERE workspace_id = ? AND user_id = ?').bind(WS, s.bob.userId).run();
    const res = await s.raw(s.bob.cookie, 'zebra');
    expect(res.status).toBe(404);
    expect(await errCode(res)).toBe('not_found');
  });

  it('FTS syntax in user text is literal and never errors', async () => {
    const s = await setup();
    const all3 = await s.say(GENERAL, 'zebra or secret');
    await s.say(GENERAL, 'zebra secret');
    for (const query of ['zebra OR secret', 'NEAR(zebra secret)', 'body:zebra', '"zebra', 'zeb*', '-zebra', '^zebra', ')(', "'; DROP TABLE messages; --", '***', 'a"b', 'zebra AND NOT secret', '{zebra}']) {
      const res = await s.raw(s.carol.cookie, query);
      expect(res.status, query).toBe(200);
    }
    expect(s.ids(await s.q(s.carol.cookie, 'zebra OR secret'))).toEqual([all3.id]);
    expect((await s.q(s.carol.cookie, 'zeb*')).results).toEqual([]);
    expect(await s.q(s.carol.cookie, '***')).toEqual({ results: [], nextCursor: null });
    expect(await s.q(s.carol.cookie, '*** has:file')).toEqual({ results: [], nextCursor: null });
    // messages table still intact
    expect((await s.q(s.carol.cookie, 'zebra')).results).toHaveLength(2);
  });

  it('rejects bad queries with their codes', async () => {
    const s = await setup();
    expect(await errCode(await s.raw(s.carol.cookie, '   '))).toBe('invalid_query');
    expect(await errCode(await s.raw(s.carol.cookie, '"""'))).toBe('invalid_query');
    const long = await s.raw(s.carol.cookie, 'z'.repeat(300));
    expect(long.status).toBe(400);
    expect(await errCode(long)).toBe('too_long');
    const huge = await s.raw(s.carol.cookie, 'z'.repeat(2000));
    expect(huge.status).toBe(400);
    expect(await errCode(huge)).toBe('invalid_request');
    // P4-R24: 200 characters max (201 is too long); extra terms are ignored, not rejected
    expect(await errCode(await s.raw(s.carol.cookie, 'z'.repeat(201)))).toBe('too_long');
    expect((await s.raw(s.carol.cookie, 'z'.repeat(200))).status).toBe(200);
    expect((await s.raw(s.carol.cookie, Array.from({ length: 17 }, (_, i) => `w${i}`).join(' '))).status).toBe(200);
    const noQ = await (async () => {
      const ctx = createExecutionContext();
      const r = await s.app.request('/w/clubhack/search', { headers: { Cookie: s.carol.cookie } }, env, ctx);
      await waitOnExecutionContext(ctx);
      return r;
    })();
    expect(noQ.status).toBe(400);
    const anon = await (async () => {
      const ctx = createExecutionContext();
      const r = await s.app.request('/w/clubhack/search?q=zebra', {}, env, ctx);
      await waitOnExecutionContext(ctx);
      return r;
    })();
    expect(anon.status).toBe(401);
  });

  it(':shortcode: text is searchable as words', async () => {
    const s = await setup();
    const m = await s.say(GENERAL, 'party time :tada:');
    expect(s.ids(await s.q(s.carol.cookie, 'tada'))).toEqual([m.id]);
    expect(s.ids(await s.q(s.carol.cookie, ':tada:'))).toEqual([m.id]);
  });

  it('file names match; has:file filters', async () => {
    const s = await setup();
    const report = await s.upload(s.alice.cookie, 'quarterly-report.pdf');
    const zf = await s.upload(s.alice.cookie, 'zebra.pdf');
    await s.upload(s.alice.cookie, 'quarterly.txt'); // never attached
    const zebraPlain = await s.say(GENERAL, 'zebra without files', { now: NOW - 3 * DAY });
    const withFile = await s.say(GENERAL, 'see attached', { fileIds: [report.id], now: NOW - 2 * DAY });
    const zebraFile = await s.say(GENERAL, 'zebra with a file', { fileIds: [zf.id], now: NOW - DAY });

    const qr = await s.q(s.carol.cookie, 'quarterly');
    expect(s.ids(qr)).toEqual([withFile.id]);
    expect(qr.results[0]!.snippet).toEqual([{ text: 'see attached', hit: false }]);

    expect(s.ids(await s.q(s.carol.cookie, 'has:file'))).toEqual([zebraFile.id, withFile.id]);
    expect(s.ids(await s.q(s.carol.cookie, 'has:file zebra'))).toEqual([zebraFile.id]);
    expect(s.ids(await s.q(s.carol.cookie, 'zebra')).sort()).toEqual([zebraPlain.id, zebraFile.id].sort());
    // A body hit and a file-name hit on the same message collapse into one result with the body snippet.
    const zr = (await s.q(s.carol.cookie, 'zebra')).results.find((r) => r.message.id === zebraFile.id)!;
    expect(zr.snippet).toContainEqual({ text: 'zebra', hit: true });
  });

  it('filters', async () => {
    const s = await setup();
    const RANDOM = '01JCLUBHACK0000000000000RD';
    const nov1 = Date.UTC(2026, 10, 1, 12);
    const nov2 = Date.UTC(2026, 10, 2, 12);
    const nov3 = Date.UTC(2026, 10, 3, 12);
    await env.DB.prepare(
      "INSERT OR IGNORE INTO channel_members (channel_id, user_id, last_read_seq, joined_at) VALUES (?, ?, 0, 1)",
    )
      .bind(RANDOM, s.alice.userId)
      .run();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO channel_members (channel_id, user_id, last_read_seq, joined_at) VALUES (?, ?, 0, 1)",
    )
      .bind(RANDOM, s.bob.userId)
      .run();
    const a1 = await s.say(GENERAL, 'zebra one', { now: nov1 });
    const a2 = await s.say(GENERAL, 'zebra two', { now: nov2 });
    const a3 = await s.say(RANDOM, 'zebra three', { now: nov3 });
    const b2 = await s.say(GENERAL, 'zebra bob', { userId: s.bob.userId, now: nov2 });

    expect(s.ids(await s.q(s.carol.cookie, 'zebra in:#general')).sort()).toEqual([a1.id, a2.id, b2.id].sort());
    expect(s.ids(await s.q(s.carol.cookie, 'zebra in:#GENERAL')).sort()).toEqual([a1.id, a2.id, b2.id].sort());
    expect(s.ids(await s.q(s.carol.cookie, `zebra in:${RANDOM}`))).toEqual([a3.id]);
    expect(s.ids(await s.q(s.carol.cookie, 'zebra from:@alice')).sort()).toEqual([a1.id, a2.id, a3.id].sort());
    expect(s.ids(await s.q(s.carol.cookie, 'zebra from:@Alice')).sort()).toEqual([a1.id, a2.id, a3.id].sort());
    expect(s.ids(await s.q(s.carol.cookie, `zebra from:${s.bob.userId}`))).toEqual([b2.id]);
    expect(s.ids(await s.q(s.carol.cookie, 'zebra after:2026-11-01')).sort()).toEqual([a2.id, a3.id, b2.id].sort());
    expect(s.ids(await s.q(s.carol.cookie, 'zebra before:2026-11-03')).sort()).toEqual([a1.id, a2.id, b2.id].sort());
    expect(s.ids(await s.q(s.carol.cookie, 'after:2026-11-01 before:2026-11-03 from:@alice'))).toEqual([a2.id]);
    // A channel named like another channel's (lower-cased) id cannot take over `in:<id>`.
    const decoy = await insertChannel({ name: RANDOM.toLowerCase(), kind: 'public', memberIds: [s.alice.userId] });
    await s.say(decoy, 'zebra decoy', { now: nov3 });
    expect(s.ids(await s.q(s.carol.cookie, `zebra in:${RANDOM}`))).toEqual([a3.id]);
    expect(await s.q(s.carol.cookie, 'zebra in:#nope')).toEqual({ results: [], nextCursor: null });
    expect(await s.q(s.carol.cookie, 'zebra from:@nobody')).toEqual({ results: [], nextCursor: null });
    const bad = await s.raw(s.carol.cookie, 'zebra before:2026-13-01');
    expect(bad.status).toBe(400);
    expect(await errCode(bad)).toBe('invalid_date');
  });

  it('from: matches display names without spaces, and only active members', async () => {
    const s = await setup();
    await env.DB.prepare("UPDATE users SET display_name = 'Alice Liddell' WHERE id = ?").bind(s.alice.userId).run();
    const m = await s.say(GENERAL, 'zebra');
    expect(s.ids(await s.q(s.carol.cookie, 'zebra from:@aliceliddell'))).toEqual([m.id]);
    await env.DB.prepare('UPDATE workspace_members SET deactivated_at = 1 WHERE workspace_id = ? AND user_id = ?').bind(WS, s.alice.userId).run();
    expect((await s.q(s.carol.cookie, 'from:@alice')).results).toEqual([]);
  });

  it('ranking: bm25 first, recency breaks ties', async () => {
    const s = await setup();
    const strong = await s.say(GENERAL, 'zebra zebra zebra', { now: NOW - 10 * DAY });
    const weak = await s.say(GENERAL, 'zebra and some other words here today', { now: NOW });
    expect(s.ids(await s.q(s.carol.cookie, 'zebra'))).toEqual([strong.id, weak.id]);

    const older = await s.say(GENERAL, 'zebra crossing', { now: NOW - 60 * DAY });
    const newer = await s.say(GENERAL, 'zebra crossing', { now: NOW });
    expect(s.ids(await s.q(s.carol.cookie, 'crossing'))).toEqual([newer.id, older.id]);
  });

  it('cursor paging', async () => {
    const s = await setup();
    const all: string[] = [];
    for (let i = 0; i < 25; i++) all.push((await s.say(GENERAL, 'zebra', { now: NOW - i * 1000 })).id);
    const p1 = await s.q(s.carol.cookie, 'zebra');
    expect(p1.results).toHaveLength(20);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await s.q(s.carol.cookie, 'zebra', p1.nextCursor!);
    expect(p2.results).toHaveLength(5);
    expect(p2.nextCursor).toBeNull();
    const ids1 = s.ids(p1);
    const ids2 = s.ids(p2);
    expect(ids1.filter((id) => ids2.includes(id))).toEqual([]);
    expect([...ids1, ...ids2].sort()).toEqual([...all].sort());
    // The cursor pins `now`, so recency scores do not drift between pages.
    expect(decodeCursor(p1.nextCursor!)).toEqual({ o: 20, t: NOW });

    // Filter-only paging works the same way.
    const f1 = await s.q(s.carol.cookie, 'from:@alice');
    expect(f1.results).toHaveLength(20);
    const f2 = await s.q(s.carol.cookie, 'from:@alice', f1.nextCursor!);
    expect(f2.results.length).toBeGreaterThan(0);
    expect(s.ids(f1).filter((id) => s.ids(f2).includes(id))).toEqual([]);

    for (const bad of [p1.nextCursor!.slice(0, -2) + 'xx', 'garbage', encodeCursor(21, NOW)]) {
      const res = await s.raw(s.carol.cookie, 'zebra', bad);
      expect(res.status).toBe(400);
      expect(await errCode(res)).toBe('invalid_cursor');
    }
  });

  it('file-only hits preview the body without cutting a mention token', async () => {
    const s = await setup();
    const f = await s.upload(s.alice.cookie, 'budget.pdf');
    const mention = `<@${s.bob.userId}>`;
    const body = `${'é'.repeat(190)} ${mention} tail`;
    await s.say(GENERAL, body, { fileIds: [f.id] });
    const hit = (await s.q(s.carol.cookie, 'budget')).results[0]!;
    expect(hit.snippet).toEqual([{ text: `${'é'.repeat(190)} `, hit: false }]);
    const g = await s.upload(s.alice.cookie, 'plan.pdf');
    await s.say(GENERAL, '', { fileIds: [g.id] });
    expect((await s.q(s.carol.cookie, 'plan')).results[0]!.snippet).toEqual([]);
  });

  it('query plans do not depend on planner statistics', async () => {
    const plan = async (hasMatch: boolean) => {
      const binds = [hasMatch ? '"zebra"' : null, WS, 'U', NOW, 21, 0];
      const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${buildSearchSql(hasMatch, '')}`)
        .bind(...binds)
        .all<{ id: number; parent: number; detail: string }>();
      return results;
    };
    const firstTopLevelAccess = (rows: { parent: number; detail: string }[]) =>
      rows.find((r) => r.parent === 0 && /^(SCAN|SEARCH) /.test(r.detail))?.detail;

    // Filter-only: a backward rowid scan of messages that stops early, never a sort over the workspace.
    const f = await plan(false);
    expect(firstTopLevelAccess(f)).toBe('SCAN m');
    expect(f.some((r) => r.detail.includes('USE TEMP B-TREE FOR ORDER BY'))).toBe(false);
    expect(f.some((r) => r.detail.includes('idx_messages_channel_seq'))).toBe(false);

    // Match: each FTS table drives its CTE branch; the outer query starts from `best` and looks rows up by key.
    const m = await plan(true);
    expect(firstTopLevelAccess(m)).toBe('SCAN best');
    expect(m.some((r) => r.detail.startsWith('SCAN messages_fts VIRTUAL TABLE'))).toBe(true);
    expect(m.some((r) => r.detail.startsWith('SCAN files_fts VIRTUAL TABLE'))).toBe(true);
    expect(m.some((r) => r.detail.includes('idx_messages_channel_seq'))).toBe(false);
    expect(m.some((r) => /^SCAN (m|c|channels|messages)\b/.test(r.detail))).toBe(false);
  });

  it('results carry files and reactions', async () => {
    const s = await setup();
    const report = await s.upload(s.alice.cookie, 'quarterly-report.pdf');
    await s.say(GENERAL, 'see attached', { fileIds: [report.id] });
    const hit = (await s.q(s.carol.cookie, 'quarterly')).results[0]!;
    expect(hit.message.files![0]!.name).toBe('quarterly-report.pdf');
    expect(Array.isArray(hit.message.reactions)).toBe(true);
  });
});
