import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { AUTH_ROW_GRACE_MS, RATE_LIMIT_KEEP_MS, cleanupAuth } from '../src/maintenance';
import { createApp } from '../src/app';
import {
  blobHead,
  blobKeys,
  blobPut,
  captureMailer,
  describeBackends,
  env,
  insertFile,
  patchBlobBinding,
  resetDb,
  seedUsers,
  testDeps,
} from './helpers';

const T = 1_800_000_000_000;
const H = 3_600_000;
const D = 86_400_000;
const WS = '01JCLUBHACK0000000000000WS';

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

async function seed() {
  await env.DB.batch([
    // login_tokens: [hash, expires_at, used_at]
    ...(
      [
        ['lt-live', T + 10 * 60_000, null], // live, unused
        ['lt-expired-23h', T - 23 * H, null], // expired, inside the grace day
        ['lt-expired-25h', T - 25 * H, null], // expired more than a day ago
        ['lt-used-1h', T + 10 * 60_000, T - H], // used recently
        ['lt-used-25h', T + 10 * 60_000, T - 25 * H], // used more than a day ago (expiry irrelevant)
      ] as const
    ).map(([h, exp, used]) =>
      env.DB.prepare('INSERT INTO login_tokens (token_hash, email, invite_id, expires_at, used_at) VALUES (?, ?, NULL, ?, ?)').bind(
        h,
        'x@test.dev',
        exp,
        used,
      ),
    ),
    ...(
      [
        ['dc-live', T + 60_000, null],
        ['dc-expired-23h', T - 23 * H, null],
        ['dc-expired-25h', T - 25 * H, null],
        ['dc-used-1h', T + 60_000, T - H],
        ['dc-used-25h', T + 60_000, T - 25 * H],
      ] as const
    ).map(([h, exp, used]) =>
      env.DB.prepare('INSERT INTO desktop_codes (code_hash, user_id, challenge, expires_at, used_at) VALUES (?, ?, ?, ?, ?)').bind(
        h,
        'u1',
        'c',
        exp,
        used,
      ),
    ),
    ...(
      [
        ['start:ip:live', T - 30 * 60_000],
        ['start:ip:119m', T - 119 * 60_000],
        ['start:ip:121m', T - 121 * 60_000],
        ['start:email:old', T - 3 * D],
        // P6-R10 daily emoji counters live for their whole UTC day (and a spare one), not 2 h.
        ['emoji:day:WS:today', T - 5 * H],
        ['emoji:day:WS:old', T - 3 * D],
      ] as const
    ).map(([k, w]) => env.DB.prepare('INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 3)').bind(k, w)),
  ]);
}

const keys = async (sql: string) => (await env.DB.prepare(sql).all<{ k: string }>()).results.map((r) => r.k).sort();
const tokens = () => keys('SELECT token_hash AS k FROM login_tokens');
const codes = () => keys('SELECT code_hash AS k FROM desktop_codes');
const limits = () => keys('SELECT key AS k FROM rate_limits');

describeBackends('cleanupAuth', () => {
  it('uses a one-day grace for auth rows and keeps rate-limit windows for 2 h', () => {
    expect(AUTH_ROW_GRACE_MS).toBe(86_400_000);
    expect(RATE_LIMIT_KEEP_MS).toBe(7_200_000);
  });

  it('deletes only expired/used auth rows older than a day and windows older than 2 h', async () => {
    await seed();
    expect(await cleanupAuth(env.DB, T)).toEqual({ loginTokens: 2, desktopCodes: 2, rateLimits: 3 });
    expect(await tokens()).toEqual(['lt-expired-23h', 'lt-live', 'lt-used-1h']);
    expect(await codes()).toEqual(['dc-expired-23h', 'dc-live', 'dc-used-1h']);
    expect(await limits()).toEqual(['emoji:day:WS:today', 'start:ip:119m', 'start:ip:live']);
    // idempotent
    expect(await cleanupAuth(env.DB, T)).toEqual({ loginTokens: 0, desktopCodes: 0, rateLimits: 0 });
  });

  it('runs from the scheduled handler; storage loses only the orphan file key, emoji/ survives', async () => {
    const { mailer, sent } = captureMailer();
    const [o] = await seedUsers(createApp(testDeps({ mailer })), sent, ['owner@test.dev']);
    // drop the sign-in's own token and rate-limit rows so only the seeded ones are judged
    await env.DB.batch([env.DB.prepare('DELETE FROM login_tokens'), env.DB.prepare('DELETE FROM rate_limits')]);
    await seed();
    await blobPut(`ws/${WS}/emoji/keepme`, new Uint8Array([1]));
    const orphan = await insertFile({ uploaderId: o!.userId, createdAt: T - 25 * H, object: new Uint8Array([1]) });
    const orphanKey = (await env.DB.prepare('SELECT r2_key AS k FROM files WHERE id = ?').bind(orphan).first<{ k: string }>())!.k;
    const deleted: string[] = [];
    const restore = patchBlobBinding((real) => ({
      delete: ((k: string | string[]) => {
        deleted.push(...[k].flat());
        return (real.delete as (k: string | string[]) => Promise<void>)(k);
      }) as never,
    }));
    const ctx = createExecutionContext();
    try {
      await worker.scheduled!(createScheduledController({ scheduledTime: new Date(T), cron: '0 4 * * *' }), env, ctx);
      await waitOnExecutionContext(ctx);
    } finally {
      restore();
    }
    expect(await tokens()).toEqual(['lt-expired-23h', 'lt-live', 'lt-used-1h']);
    expect(await codes()).toEqual(['dc-expired-23h', 'dc-live', 'dc-used-1h']);
    expect(await limits()).toEqual(['emoji:day:WS:today', 'start:ip:119m', 'start:ip:live']);
    expect(deleted).toEqual([orphanKey]);
    expect(await blobHead(orphanKey)).toBeNull();
    expect(await blobHead(`ws/${WS}/emoji/keepme`)).not.toBeNull();
    expect(await blobKeys()).toEqual([`ws/${WS}/emoji/keepme`]);
  });

  it('an orphan-cleanup failure does not stop the auth cleanup (and vice versa logs its own code)', async () => {
    await seed();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const realPrepare = env.DB.prepare.bind(env.DB);
    vi.spyOn(env.DB, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes('FROM files')) throw new Error('files down');
      return realPrepare(sql);
    });
    const ctx = createExecutionContext();
    await worker.scheduled!(createScheduledController({ scheduledTime: new Date(T), cron: '0 4 * * *' }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('orphan_cleanup_failed'));
    expect(await tokens()).toEqual(['lt-expired-23h', 'lt-live', 'lt-used-1h']);
  });

  it('logs auth_cleanup_failed when D1 fails', async () => {
    vi.spyOn(env.DB, 'prepare').mockImplementation(() => {
      throw new Error('d1 down');
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ctx = createExecutionContext();
    await worker.scheduled!(createScheduledController({ scheduledTime: new Date(T), cron: '0 4 * * *' }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('auth_cleanup_failed'));
  });
});
