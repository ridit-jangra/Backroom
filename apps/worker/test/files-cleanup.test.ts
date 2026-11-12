import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { createApp } from '../src/app';
import { ORPHAN_BATCH, cleanupOrphans } from '../src/files/cleanup';
import { deleteMessage, sendMessage } from '../src/messaging/store';
import { GENERAL, captureMailer, insertFile, resetDb, seedUsers, testDeps } from './helpers';

const T = 1_800_000_000_000;
const H = 3_600_000;
const WS = '01JCLUBHACK0000000000000WS';
const EMOJI_KEY = `ws/${WS}/emoji/${'E'.repeat(26)}`;
const bytes = new Uint8Array([1, 2, 3]);

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

async function owner() {
  const { mailer, sent } = captureMailer();
  const [o] = await seedUsers(createApp(testDeps({ mailer })), sent, ['owner@test.dev']);
  return o!.userId;
}
const rowExists = async (id: string) =>
  (await env.DB.prepare('SELECT 1 AS x FROM files WHERE id = ?').bind(id).first()) !== null;
const keysOf = async (id: string) =>
  (await env.DB.prepare('SELECT r2_key AS k, thumb_key AS t FROM files WHERE id = ?').bind(id).first<{ k: string; t: string | null }>())!;
const has = async (k: string) => (await env.BUCKET.head(k)) !== null;
const fileCount = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM files').first<{ n: number }>())!.n;

async function bulk(n: number, createdAt: number, uploader: string) {
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < n; i++) {
    const id = `01BULK${String(i).padStart(20, '0')}`;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO files (id, workspace_id, uploader_id, r2_key, thumb_key, name, mime, size, width, height, created_at)
         VALUES (?, ?, ?, ?, NULL, 'b.bin', 'application/octet-stream', 0, NULL, NULL, ?)`,
      ).bind(id, WS, uploader, `ws/${WS}/${id}`, createdAt + i),
    );
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
}

describe('cleanupOrphans', () => {
  it('removes old orphans, keeps young and attached, rejects emoji keys', async () => {
    const u = await owner();
    await env.BUCKET.put(`ws/${WS}/emoji/keepme`, bytes);
    const a = await insertFile({ uploaderId: u, name: 'zebra-report.bin', createdAt: T - 25 * H, object: bytes, thumb: true });
    const ka = await keysOf(a);
    const b = await insertFile({ uploaderId: u, createdAt: T - 23 * H, object: bytes });
    const c = await insertFile({ uploaderId: u, createdAt: T - 30 * 86_400_000, object: bytes });
    await env.DB.prepare("INSERT INTO message_files (message_id, file_id) VALUES ('m1', ?)").bind(c).run();
    const d = await insertFile({ uploaderId: u, createdAt: T - 2 * H, object: bytes });
    const sent = await sendMessage(env.DB, {
      clientId: 'c1', channelId: GENERAL, userId: u, parentId: null, body: '', alsoInChannel: false, fileIds: [d], now: T - 2 * H,
    });
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    const e = await insertFile({ uploaderId: u, createdAt: T - 30 * H, r2Key: EMOJI_KEY });
    await env.BUCKET.put(EMOJI_KEY, bytes);

    // run at T: A and E go; B (23 h), C (attached) and D (attached) stay
    expect(await cleanupOrphans(env, T)).toEqual({ deleted: 2, keysRejected: 1 });
    expect(await rowExists(b)).toBe(true);
    expect(await rowExists(c)).toBe(true);
    expect(await rowExists(d)).toBe(true);
    await deleteMessage(env.DB, { messageId: sent.message.id, userId: u, now: T - H });
    expect(await rowExists(a)).toBe(false); // first run already removed A

    const r = await cleanupOrphans(env, T + 23 * H);
    expect(r).toEqual({ deleted: 2, keysRejected: 0 }); // D (now 25 h old) and B (46 h old)
    expect(await has(ka.k)).toBe(false);
    expect(await has(ka.t!)).toBe(false);
    expect(await rowExists(b)).toBe(false);
    expect(await rowExists(c)).toBe(true);
    expect(await rowExists(d)).toBe(false);
    expect(await rowExists(e)).toBe(false);
    expect(await has(EMOJI_KEY)).toBe(true);
    expect(await has(`ws/${WS}/emoji/keepme`)).toBe(true);
    const fts = await env.DB.prepare("SELECT COUNT(*) AS n FROM files_fts WHERE files_fts MATCH 'zebra'").first<{ n: number }>();
    expect(fts!.n).toBe(0);
  });

  it('counts rejected keys (emoji key row)', async () => {
    const u = await owner();
    await env.BUCKET.put(EMOJI_KEY, bytes);
    await insertFile({ uploaderId: u, createdAt: T - 30 * H, r2Key: EMOJI_KEY });
    expect(await cleanupOrphans(env, T)).toEqual({ deleted: 1, keysRejected: 1 });
    expect(await has(EMOJI_KEY)).toBe(true);
    expect(await fileCount()).toBe(0);
  });

  it('runs through the scheduled handler', async () => {
    const u = await owner();
    const a = await insertFile({ uploaderId: u, createdAt: T - 25 * H, object: bytes, thumb: true });
    const k = await keysOf(a);
    const ctx = createExecutionContext();
    await worker.scheduled!(createScheduledController({ scheduledTime: new Date(T), cron: '0 4 * * *' }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await rowExists(a)).toBe(false);
    expect(await has(k.k)).toBe(false);
    expect(await has(k.t!)).toBe(false);
  });

  it('the scheduled handler settles and logs when D1 fails', async () => {
    vi.spyOn(env.DB, 'prepare').mockImplementation(() => {
      throw new Error('d1 down');
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = createExecutionContext();
    await worker.scheduled!(createScheduledController({ scheduledTime: new Date(T), cron: '0 4 * * *' }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('orphan_cleanup_failed'));
  });

  it('batches: 250 orphans in one run; at most 1,000 per run', async () => {
    const u = await owner();
    await bulk(250, T - 30 * H, u);
    expect((await cleanupOrphans(env, T)).deleted).toBe(250);
    await bulk(1050, T - 30 * H, u);
    expect((await cleanupOrphans(env, T)).deleted).toBe(1000);
    expect(await fileCount()).toBe(50);
    expect((await cleanupOrphans(env, T)).deleted).toBe(50);
    expect(ORPHAN_BATCH).toBe(100);
  });

  it('an R2 failure does not stop the run', async () => {
    const u = await owner();
    for (let i = 0; i < 3; i++) await insertFile({ uploaderId: u, createdAt: T - 25 * H - i, object: bytes });
    vi.spyOn(env.BUCKET, 'delete').mockRejectedValueOnce(new Error('x'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(cleanupOrphans(env, T)).resolves.toEqual({ deleted: 3, keysRejected: 0 });
    expect(await fileCount()).toBe(0);
  });
});
