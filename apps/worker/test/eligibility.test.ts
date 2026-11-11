import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { checkEligibility, checkEligibilityByInviteId } from '../src/auth/eligibility';
import { sha256Hex } from '../src/lib/crypto';
import { ApiError } from '../src/lib/errors';
import { acceptLogin } from '../src/workspace/membership';

const WS = '01JCLUBHACK0000000000000WS';
const GN = '01JCLUBHACK0000000000000GN';
const OWNER = 'owner@test.dev';
const now = 1_800_000_000_000;
const db = () => env.DB;

async function addInvite(id: string, token: string, opts: { expires?: number; max?: number } = {}) {
  await db()
    .prepare('INSERT INTO invites (id, workspace_id, token_hash, expires_at, max_uses, uses) VALUES (?, ?, ?, ?, ?, 0)')
    .bind(id, WS, await sha256Hex(token), opts.expires ?? now + 1000, opts.max ?? 1)
    .run();
}
async function addMember(userId: string, email: string, role: string, deactivated: number | null = null) {
  await db().batch([
    db().prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)').bind(userId, email, now),
    db()
      .prepare('INSERT INTO workspace_members (workspace_id, user_id, role, joined_at, deactivated_at) VALUES (?, ?, ?, ?, ?)')
      .bind(WS, userId, role, now, deactivated),
  ]);
}
const roleOf = async (email: string) =>
  (
    await db()
      .prepare('SELECT wm.role FROM workspace_members wm JOIN users u ON u.id = wm.user_id WHERE u.email = ?')
      .bind(email)
      .first<{ role: string }>()
  )?.role;
const count = async (sql: string, ...b: unknown[]) => (await db().prepare(sql).bind(...b).first<{ n: number }>())!.n;

beforeEach(async () => {
  await db().batch([
    db().prepare('DELETE FROM invites'),
    db().prepare('DELETE FROM channel_members'),
    db().prepare('DELETE FROM workspace_members'),
    db().prepare('DELETE FROM users'),
  ]);
});

describe('eligibility', () => {
  it('unknown email without invite is ineligible', async () => {
    expect(await checkEligibility(db(), 'x@example.com', undefined, OWNER, now)).toEqual({ ok: false });
  });

  it('empty or unset owner email never matches and does not throw', async () => {
    expect(await checkEligibility(db(), 'x@example.com', undefined, '', now)).toEqual({ ok: false });
    expect(await checkEligibility(db(), 'x@example.com', undefined, undefined, now)).toEqual({ ok: false });
  });

  it('owner email bootstraps owner', async () => {
    expect(await checkEligibility(db(), OWNER, undefined, OWNER, now)).toEqual({ ok: true, inviteId: null });
    const { userId } = await acceptLogin(db(), OWNER, null, OWNER, now);
    expect(await roleOf(OWNER)).toBe('owner');
    expect(await count('SELECT count(*) AS n FROM channel_members WHERE channel_id = ? AND user_id = ?', GN, userId)).toBe(1);
  });

  it('owner email only bootstraps once', async () => {
    await addMember('01JUSER00000000000000000001', 'other@example.com', 'owner');
    expect(await checkEligibility(db(), OWNER, undefined, OWNER, now)).toEqual({ ok: false });
    expect(await count("SELECT count(*) AS n FROM workspace_members WHERE role = 'owner'")).toBe(1);
  });

  it('owner accept falls back to member if an owner appeared after eligibility', async () => {
    expect(await checkEligibility(db(), OWNER, undefined, OWNER, now)).toEqual({ ok: true, inviteId: null });
    await addMember('01JUSER00000000000000000001', 'other@example.com', 'owner');
    const { userId } = await acceptLogin(db(), OWNER, null, OWNER, now);
    expect(await roleOf(OWNER)).toBe('member');
    expect(await count("SELECT count(*) AS n FROM workspace_members WHERE role = 'owner'")).toBe(1);
    expect(await count('SELECT count(*) AS n FROM channel_members WHERE channel_id = ? AND user_id = ?', GN, userId)).toBe(1);
  });

  it('valid invite is eligible and consumed once', async () => {
    await addInvite('inv1', 'tok1');
    const e = await checkEligibility(db(), 'new@example.com', 'tok1', OWNER, now);
    expect(e).toEqual({ ok: true, inviteId: 'inv1' });
    await acceptLogin(db(), 'new@example.com', 'inv1', OWNER, now);
    expect(await count('SELECT uses AS n FROM invites WHERE id = ?', 'inv1')).toBe(1);
    expect(await roleOf('new@example.com')).toBe('member');
    expect(await checkEligibility(db(), 'two@example.com', 'tok1', OWNER, now)).toEqual({ ok: false });
    expect(await checkEligibilityByInviteId(db(), 'two@example.com', 'inv1', OWNER, now)).toEqual({ ok: false });
  });

  it('expired invite is ineligible', async () => {
    await addInvite('inv2', 'tok2', { expires: now - 1 });
    expect(await checkEligibility(db(), 'new@example.com', 'tok2', OWNER, now)).toEqual({ ok: false });
  });

  it('existing member re-login does not consume invite uses', async () => {
    await addInvite('inv3', 'tok3', { max: 5 });
    await acceptLogin(db(), 'm@example.com', 'inv3', OWNER, now);
    await acceptLogin(db(), 'm@example.com', 'inv3', OWNER, now);
    expect(await count('SELECT uses AS n FROM invites WHERE id = ?', 'inv3')).toBe(1);
    expect(await count('SELECT count(*) AS n FROM workspace_members')).toBe(1);
    expect(await count('SELECT count(*) AS n FROM channel_members')).toBe(1);
  });

  it('deactivated member is ineligible', async () => {
    await addMember('01JUSER00000000000000000002', OWNER, 'member', now);
    await addInvite('inv4', 'tok4');
    expect(await checkEligibility(db(), OWNER, undefined, OWNER, now)).toEqual({ ok: false });
    expect(await checkEligibility(db(), OWNER, 'tok4', OWNER, now)).toEqual({ ok: false });
  });

  it('normalizes email', async () => {
    await db().prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)').bind('01JUSER00000000000000000003', 'alice@example.com', now).run();
    await addInvite('inv7', 'tok7');
    const { userId } = await acceptLogin(db(), ' Alice@Example.COM ', 'inv7', OWNER, now);
    expect(userId).toBe('01JUSER00000000000000000003');
    expect(await count('SELECT count(*) AS n FROM users WHERE email = ?', 'alice@example.com')).toBe(1);
  });

  it('acceptLogin rejects when the invite was exhausted after eligibility', async () => {
    await addInvite('inv5', 'tok5');
    expect(await checkEligibilityByInviteId(db(), 'late@example.com', 'inv5', OWNER, now)).toEqual({ ok: true, inviteId: 'inv5' });
    await db().prepare('UPDATE invites SET uses = max_uses WHERE id = ?').bind('inv5').run();
    await expect(acceptLogin(db(), 'late@example.com', 'inv5', OWNER, now)).rejects.toMatchObject({ status: 403, code: 'not_allowed' });
    await expect(acceptLogin(db(), 'late@example.com', 'inv5', OWNER, now)).rejects.toBeInstanceOf(ApiError);
    expect(await count('SELECT count(*) AS n FROM workspace_members')).toBe(0);
    expect(await count('SELECT count(*) AS n FROM channel_members')).toBe(0);
    expect(await count('SELECT uses AS n FROM invites WHERE id = ?', 'inv5')).toBe(1);
  });

  it('acceptLogin twice for the same new email consumes one use', async () => {
    await addInvite('inv6', 'tok6', { max: 2 });
    const a = await acceptLogin(db(), 'dup@example.com', 'inv6', OWNER, now);
    const b = await acceptLogin(db(), 'dup@example.com', 'inv6', OWNER, now);
    expect(a.userId).toBe(b.userId);
    expect(await count('SELECT uses AS n FROM invites WHERE id = ?', 'inv6')).toBe(1);
  });

  it('acceptLogin refuses a deactivated member', async () => {
    await addMember('01JUSER00000000000000000004', 'gone@example.com', 'member', now);
    await expect(acceptLogin(db(), 'gone@example.com', null, OWNER, now)).rejects.toMatchObject({ status: 403, code: 'not_allowed' });
  });
});
