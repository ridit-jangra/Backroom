import { CUSTOM_EMOJI_LIMIT, FILES_QUOTA_BYTES, ORPHAN_TTL_MS, parseSearchQuery, type ParsedSearch } from '@backroom/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// Real application code from the worker, run unchanged on the Node adapters.
import { memberSummariesFor } from '../../worker/src/channels/channels';
import { acceptLogin } from '../../worker/src/workspace/membership';
import { createCustomEmoji, emojiKey } from '../../worker/src/emoji/custom';
import type { Env } from '../../worker/src/env';
import { cleanupOrphans } from '../../worker/src/files/cleanup';
import { fileKey } from '../../worker/src/files/store';
import type { BlobStore } from '../../worker/src/lib/blobs';
import { blobBytesUsed, blobBytesUsedSql } from '../../worker/src/lib/quota';
import { hitRateLimit } from '../../worker/src/lib/rateLimit';
import { deleteMessage, editMessage, sendMessage } from '../../worker/src/messaging/store';
import { searchMessages } from '../../worker/src/search/search';
import { newId } from '../../worker/src/lib/ids';
import { type NodeD1Database, createD1 } from '../src/platform/d1';
import { createFsBlobStore } from '../src/platform/fs-blobs';
import { applyMigrations } from '../src/platform/migrate';
import { MIGRATIONS_DIR, bytes, storedFiles, tempDir } from './helpers';

const WS = '01JCLUBHACK0000000000000WS';
const GENERAL = '01JCLUBHACK0000000000000GN';
const NOW = 1_800_000_000_000;
const ALICE = '01JALICE000000000000000000';
const BOB = '01JB0B00000000000000000000';

let db: NodeD1Database;
let store: BlobStore;
let env: Env;
let blobDir: string;

async function addUser(id: string, name: string, role = 'member'): Promise<void> {
  await db.batch([
    db.prepare('INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, 0)').bind(id, `${name}@test.dev`, name),
    db.prepare('INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, 0)').bind(WS, id, role),
    db.prepare('INSERT INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, 0)').bind(GENERAL, id),
  ]);
}

async function send(userId: string, body: string, now = NOW) {
  const r = await sendMessage(db, {
    clientId: crypto.randomUUID(),
    channelId: GENERAL,
    userId,
    parentId: null,
    body,
    alsoInChannel: false,
    fileIds: [],
    now,
  });
  if (!r.ok) throw new Error(`send failed: ${r.code}`);
  return r.message;
}

function search(q: string, userId = ALICE) {
  const parsed = parseSearchQuery(q);
  if (!parsed.ok) throw new Error(parsed.code);
  return searchMessages(db, { workspaceId: WS, userId, query: parsed.query as ParsedSearch, offset: 0, now: NOW + 1000 });
}

async function insertFile(id: string, name: string, size: number, createdAt = NOW): Promise<void> {
  await db
    .prepare(
      `INSERT INTO files (id, workspace_id, uploader_id, r2_key, thumb_key, name, mime, size, width, height, created_at)
       VALUES (?1, ?2, ?3, ?4, NULL, ?5, 'text/plain', ?6, NULL, NULL, ?7)`,
    )
    .bind(id, WS, ALICE, fileKey(WS, id), name, size, createdAt)
    .run();
}

beforeEach(async () => {
  db = createD1(':memory:');
  await applyMigrations(db, MIGRATIONS_DIR);
  blobDir = tempDir();
  store = createFsBlobStore(blobDir);
  env = { DB: db, BLOB_STORE: store } as unknown as Env;
  await addUser(ALICE, 'alice', 'owner');
  await addUser(BOB, 'bob');
});
afterEach(() => db.close());

describe('messaging and full-text search (bm25, snippet, json_each)', () => {
  it('sendMessage (batch) indexes the body; search ranks with bm25 and marks hits with snippet()', async () => {
    await send(ALICE, 'the quick brown fox jumps over the lazy dog');
    await send(BOB, 'a fox again, fox fox');
    await send(BOB, 'nothing relevant here');
    const { hits, hasMore } = await search('fox');
    expect(hasMore).toBe(false);
    expect(hits).toHaveLength(2);
    // bm25: the body with more "fox" occurrences scores better and comes first.
    expect(hits[0]!.message.body).toBe('a fox again, fox fox');
    expect(hits[0]!.snippet.filter((s) => s.hit).map((s) => s.text)).toEqual(['fox', 'fox', 'fox']);
    expect(hits[1]!.snippet.some((s) => s.hit && s.text === 'fox')).toBe(true);
  });

  it('from: filters through json_each over the resolved user ids; the filter-only path works too', async () => {
    await send(ALICE, 'zebra from alice');
    await send(BOB, 'zebra from bob');
    const fromBob = await search('zebra from:bob');
    expect(fromBob.hits.map((h) => h.message.userId)).toEqual([BOB]);
    const allBob = await search('from:bob');
    expect(allBob.hits.map((h) => h.message.body)).toEqual(['zebra from bob']);
  });

  it('edits and deletes keep the external-content FTS index in sync through the triggers', async () => {
    const m = await send(ALICE, 'original walrus');
    expect((await editMessage(db, { messageId: m.id, userId: ALICE, body: 'renamed narwhal', now: NOW + 1 })).ok).toBe(true);
    expect((await search('walrus')).hits).toHaveLength(0);
    expect((await search('narwhal')).hits).toHaveLength(1);
    expect((await deleteMessage(db, { messageId: m.id, userId: ALICE, now: NOW + 2 })).ok).toBe(true);
    expect((await search('narwhal')).hits).toHaveLength(0);
  });

  it('file-name hits come through files_fts and message_files', async () => {
    const m = await send(ALICE, 'see attachment');
    const fid = newId(NOW);
    await insertFile(fid, 'quarterly-report.pdf', 10);
    await db.prepare('INSERT INTO message_files (message_id, file_id) VALUES (?, ?)').bind(m.id, fid).run();
    const { hits } = await search('quarterly');
    expect(hits.map((h) => h.message.id)).toEqual([m.id]);
  });
});

describe('meta.changes counts only the statement\'s own rows (not FTS trigger rows)', () => {
  it('insert, rename and delete on files (each fires a files_fts trigger) report 1', async () => {
    const id = newId(NOW);
    const ins = await db
      .prepare(`INSERT INTO files (id, workspace_id, uploader_id, r2_key, name, mime, size, created_at) VALUES (?, ?, ?, ?, 'a b c', 'text/plain', 1, 0)`)
      .bind(id, WS, ALICE, fileKey(WS, id))
      .run();
    expect(ins.meta.changes).toBe(1);
    expect((await db.prepare("UPDATE files SET name = 'd e f' WHERE id = ?").bind(id).run()).meta.changes).toBe(1);
    expect((await db.prepare('DELETE FROM files WHERE id = ?').bind(id).run()).meta.changes).toBe(1);
    expect((await db.prepare('DELETE FROM files WHERE id = ?').bind(id).run()).meta.changes).toBe(0);
  });

  it('message insert/update with FTS triggers inside a batch report their own rows', async () => {
    const id = newId(NOW);
    const [ins, upd] = await db.batch([
      db
        .prepare(
          `INSERT INTO messages (id, channel_id, seq, user_id, parent_id, body, also_in_channel, created_at, client_id)
           SELECT ?, id, last_seq + 1, ?, NULL, ?, 0, ?, ? FROM channels WHERE id = ?`,
        )
        .bind(id, ALICE, 'hello trigger world', NOW, 'c1', GENERAL),
      db.prepare("UPDATE messages SET body = 'bye' WHERE id = ?").bind(id),
    ]);
    expect(ins!.meta.changes).toBe(1);
    expect(upd!.meta.changes).toBe(1);
  });
});

describe('conditional writes with RETURNING', () => {
  it('hitRateLimit: INSERT … ON CONFLICT DO UPDATE … RETURNING count, window reset', async () => {
    const hits = [];
    for (let i = 0; i < 4; i++) hits.push(await hitRateLimit(db, 'k', 3, 60_000, NOW));
    expect(hits).toEqual([true, true, true, false]);
    expect(await hitRateLimit(db, 'k', 3, 60_000, NOW + 60_000)).toBe(true);
    expect(await db.prepare('SELECT count FROM rate_limits WHERE key = ?').bind('k').first('count')).toBe(1);
  });

  it('UPDATE … WHERE used_at IS NULL … RETURNING is single-use', async () => {
    await db.prepare('INSERT INTO login_tokens (token_hash, email, expires_at) VALUES (?, ?, ?)').bind('h', 'a@test.dev', NOW + 1000).run();
    const sql = 'UPDATE login_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING email, invite_id, desktop_challenge';
    expect(await db.prepare(sql).bind(NOW, 'h', NOW).first()).toEqual({ email: 'a@test.dev', invite_id: null, desktop_challenge: null });
    expect(await db.prepare(sql).bind(NOW, 'h', NOW).first()).toBeNull();
  });

  it('cleanupOrphans: DELETE … IN (SELECT value FROM json_each(?1)) … RETURNING id, blobs removed from the filesystem store', async () => {
    const old = NOW - ORPHAN_TTL_MS - 1;
    const ids = [newId(old), newId(old), newId(NOW)];
    for (const id of ids) {
      await insertFile(id, 'orphan.txt', 3, id === ids[2] ? NOW : old);
      await store.put(fileKey(WS, id), bytes(3), { size: 3 });
    }
    const r = await cleanupOrphans(env, NOW);
    expect(r).toEqual({ deleted: 2, keysRejected: 0 });
    expect(await store.get(fileKey(WS, ids[0]!))).toBeNull();
    expect(await store.get(fileKey(WS, ids[1]!))).toBeNull();
    expect(await store.peek(fileKey(WS, ids[2]!), 3)).toEqual(bytes(3));
    expect(await db.prepare('SELECT id FROM files').raw()).toEqual([[ids[2]]]);
  });
});

describe('invite use counting through changes() inside a batch (workspace/membership.ts)', () => {
  const INVITE = '01JINVITE00000000000000000';
  beforeEach(async () => {
    await db
      .prepare('INSERT INTO invites (id, workspace_id, token_hash, created_by, expires_at, max_uses, uses) VALUES (?, ?, ?, ?, ?, 5, 0)')
      .bind(INVITE, WS, 'th', ALICE, NOW + 86_400_000)
      .run();
  });
  const uses = () => db.prepare('SELECT uses FROM invites WHERE id = ?').bind(INVITE).first('uses');

  it('a new member (INSERT … ON CONFLICT DO NOTHING inserted a row) consumes one use', async () => {
    await acceptLogin(db, 'new@test.dev', INVITE, undefined, NOW);
    expect(await uses()).toBe(1);
    // An existing member logging in again with the invite does not consume another.
    await acceptLogin(db, 'new@test.dev', INVITE, undefined, NOW + 1);
    expect(await uses()).toBe(1);
  });

  it('two racing logins for one email: the conflicting insert (changes() = 0) does not bump uses', async () => {
    await Promise.all([acceptLogin(db, 'race@test.dev', INVITE, undefined, NOW), acceptLogin(db, 'race@test.dev', INVITE, undefined, NOW)]);
    expect(await uses()).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM workspace_members wm JOIN users u ON u.id = wm.user_id WHERE u.email = 'race@test.dev'").first('n')).toBe(1);
  });
});

describe('quota expression (lib/quota.ts)', () => {
  it('blobBytesUsed sums files (size + thumb_size) and custom emoji sizes for the workspace only', async () => {
    expect(await blobBytesUsed(db, WS)).toBe(0);
    await insertFile(newId(NOW), 'a', 100);
    await db.prepare('UPDATE files SET thumb_size = 7').run();
    await db
      .prepare("INSERT INTO custom_emoji (id, workspace_id, name, r2_key, created_at, size) VALUES ('E1', ?, 'party', 'k', 0, 20)")
      .bind(WS)
      .run();
    await db
      .prepare("INSERT INTO custom_emoji (id, workspace_id, name, r2_key, created_at, size) VALUES ('E2', 'OTHER', 'party', 'k', 0, 999)")
      .run();
    expect(await blobBytesUsed(db, WS)).toBe(127);
  });

  it('the conditional upload insert (WHERE used + size <= quota) inserts at the limit and refuses past it', async () => {
    await insertFile(newId(NOW), 'big', FILES_QUOTA_BYTES - 10);
    const insert = (size: number) =>
      db
        .prepare(
          `INSERT INTO files (id, workspace_id, uploader_id, r2_key, thumb_key, name, mime, size, width, height, created_at)
           SELECT ?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?8, ?9, ?10
           WHERE ${blobBytesUsedSql('?2')} + ?7 <= ?11`,
        )
        .bind(newId(NOW), WS, ALICE, 'k', 'n', 'text/plain', size, null, null, NOW, FILES_QUOTA_BYTES)
        .run();
    expect((await insert(11)).meta.changes).toBe(0);
    expect((await insert(10)).meta.changes).toBe(1);
    expect((await insert(1)).meta.changes).toBe(0);
  });

  it('createCustomEmoji (batch, conditional insert, blob put on the filesystem store) succeeds, then refuses over quota and cleans the blob up', async () => {
    const ok = await createCustomEmoji(env, { workspaceId: WS, userId: ALICE, name: 'party', bytes: bytes(50), mime: 'image/png', now: NOW });
    expect(await store.peek(emojiKey(WS, ok.id), 50)).toEqual(bytes(50));
    expect(await blobBytesUsed(db, WS)).toBe(50);

    await insertFile(newId(NOW), 'big', FILES_QUOTA_BYTES - 60);
    const before = await db.prepare('SELECT COUNT(*) AS n FROM custom_emoji').first('n');
    const e = await createCustomEmoji(env, { workspaceId: WS, userId: ALICE, name: 'toobig', bytes: bytes(20), mime: 'image/png', now: NOW + 1 }).catch(
      (x: unknown) => x,
    );
    expect(e).toMatchObject({ status: 413, code: 'quota_exceeded' });
    expect(await db.prepare('SELECT COUNT(*) AS n FROM custom_emoji').first('n')).toBe(before);
    // Only the first emoji's blob is left: the refused one was deleted again.
    expect(storedFiles(blobDir).filter((f) => f.endsWith('.json'))).toHaveLength(1);
    expect(CUSTOM_EMOJI_LIMIT).toBeGreaterThan(1);
  });

  it('a duplicate emoji name surfaces SQLite\'s UNIQUE text so the app maps it to name_taken (409)', async () => {
    await createCustomEmoji(env, { workspaceId: WS, userId: ALICE, name: 'dup', bytes: bytes(5), mime: 'image/png', now: NOW });
    const e = await createCustomEmoji(env, { workspaceId: WS, userId: ALICE, name: 'dup', bytes: bytes(5), mime: 'image/png', now: NOW + 1 }).catch(
      (x: unknown) => x,
    );
    expect(e).toMatchObject({ status: 409, code: 'name_taken' });
  });
});

describe('batch atomicity with real application statements', () => {
  it('a failure inside a send-shaped batch leaves no message, no seq bump and no FTS entry', async () => {
    const id = newId(NOW);
    await expect(
      db.batch([
        db
          .prepare(
            `INSERT INTO messages (id, channel_id, seq, user_id, parent_id, body, also_in_channel, created_at, client_id)
             SELECT ?, id, last_seq + 1, ?, ?, ?, ?, ?, ? FROM channels WHERE id = ?`,
          )
          .bind(id, ALICE, null, 'atomic platypus', 0, NOW, 'cid', GENERAL),
        db.prepare('UPDATE channels SET last_seq = last_seq + 1 WHERE id = ?').bind(GENERAL),
        db.prepare("INSERT INTO mentions (message_id, user_id, kind) VALUES (?, NULL, 'bogus')").bind(id), // CHECK fails
      ]),
    ).rejects.toThrow('CHECK constraint failed');
    expect(await db.prepare('SELECT COUNT(*) AS n FROM messages').first('n')).toBe(0);
    expect(await db.prepare('SELECT last_seq FROM channels WHERE id = ?').bind(GENERAL).first('last_seq')).toBe(0);
    expect((await search('platypus')).hits).toHaveLength(0);
  });

  it('two racing sends with one clientId: the loser\'s batch fails on the unique index, rolls back, and dedupes', async () => {
    const input = { clientId: 'same', channelId: GENERAL, userId: ALICE, parentId: null, body: 'once', alsoInChannel: false, fileIds: [], now: NOW };
    const [a, b] = await Promise.all([sendMessage(db, input), sendMessage(db, input)]);
    expect(a.ok && b.ok).toBe(true);
    expect([a, b].filter((r) => r.ok && r.duplicate)).toHaveLength(1);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM messages').first('n')).toBe(1);
    expect(await db.prepare('SELECT last_seq FROM channels WHERE id = ?').bind(GENERAL).first('last_seq')).toBe(1);
  });
});

describe('the 100-parameter limit the app chunks around', () => {
  it('memberSummariesFor chunks 250 ids into 90-id statements (91 parameters each) and returns them all', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `U${String(i).padStart(25, '0')}`);
    await db.batch(
      ids.map((u) => db.prepare('INSERT INTO channel_members (channel_id, user_id, joined_at) VALUES (?, ?, 0)').bind(GENERAL, u)),
    );
    const out = await memberSummariesFor(db, GENERAL, ids);
    expect(Object.keys(out)).toHaveLength(250);
  });

  it('the same statement with 100 ids (101 parameters) is refused, so un-chunked code fails in tests as on D1', async () => {
    const ids = Array.from({ length: 100 }, (_, i) => `U${i}`);
    await expect(
      db
        .prepare(`SELECT user_id FROM channel_members WHERE channel_id = ? AND user_id IN (${ids.map(() => '?').join(',')})`)
        .bind(GENERAL, ...ids)
        .all(),
    ).rejects.toThrow(/too many SQL variables/);
  });
});
