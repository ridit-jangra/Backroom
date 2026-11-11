import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Bootstrap, InviteSummary, Me, MemberSummary } from '@backroom/protocol';
import { createApp } from '../src/app';
import { captureMailer, resetDb, send, signIn, testDeps } from './helpers';

beforeEach(resetDb);

async function setup() {
  const { mailer, sent } = captureMailer();
  const app = createApp(testDeps({ mailer }));
  const ownerCookie = await signIn(app, sent, 'owner@test.dev');
  return { app, sent, ownerCookie };
}

async function createInvite(app: ReturnType<typeof createApp>, cookie: string, body: object = {}) {
  const res = await send(app, 'POST', '/w/clubhack/invites', body, cookie);
  return { res, json: (await res.json()) as { invite: InviteSummary; url: string } };
}

async function joinVia(app: ReturnType<typeof createApp>, sent: { to: string; url: string }[], ownerCookie: string, email: string) {
  const { json } = await createInvite(app, ownerCookie);
  const token = json.url.split('/invite/')[1]!;
  const cookie = await signIn(app, sent, email, token);
  const me = (await (await send(app, 'GET', '/me', undefined, cookie)).json()) as Me;
  return { cookie, id: me.id };
}

describe('invites and members', () => {
  it('admin creates invite; invitee signs in via inviteToken and becomes a member in general', async () => {
    const { app, sent, ownerCookie } = await setup();
    const { res, json } = await createInvite(app, ownerCookie);
    expect(res.status).toBe(201);
    expect(json.url.startsWith('https://app.test/invite/')).toBe(true);
    expect(json.invite.maxUses).toBe(50);
    expect(json.invite.uses).toBe(0);
    const cookie = await signIn(app, sent, 'new@test.dev', json.url.split('/invite/')[1]!);
    const b = (await (await send(app, 'GET', '/w/clubhack/bootstrap', undefined, cookie)).json()) as Bootstrap;
    expect(b.channels.map((c) => c.name)).toContain('general');
    const list = (await (await send(app, 'GET', '/w/clubhack/invites', undefined, ownerCookie)).json()) as { invites: InviteSummary[] };
    expect(list.invites).toHaveLength(1);
    expect(list.invites[0]!.uses).toBe(1);
    expect(JSON.stringify(list)).not.toContain(json.url.split('/invite/')[1]!);
  });

  it('member cannot create invites (403 forbidden)', async () => {
    const { app, sent, ownerCookie } = await setup();
    const m = await joinVia(app, sent, ownerCookie, 'm@test.dev');
    const res = await send(app, 'POST', '/w/clubhack/invites', {}, m.cookie);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('forbidden');
  });

  it('revoked invite no longer grants a link', async () => {
    const { app, sent, ownerCookie } = await setup();
    const { json } = await createInvite(app, ownerCookie);
    const del = await send(app, 'DELETE', `/invites/${json.invite.id}`, undefined, ownerCookie);
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });
    const before = sent.length;
    await send(app, 'POST', '/auth/start', { email: 'late@test.dev', inviteToken: json.url.split('/invite/')[1] });
    expect(sent.length).toBe(before);
    const list = (await (await send(app, 'GET', '/w/clubhack/invites', undefined, ownerCookie)).json()) as { invites: InviteSummary[] };
    expect(list.invites).toHaveLength(0);
    expect((await send(app, 'DELETE', '/invites/nope', undefined, ownerCookie)).status).toBe(404);
  });

  it('deactivating a member kills their sessions', async () => {
    const { app, sent, ownerCookie } = await setup();
    const m = await joinVia(app, sent, ownerCookie, 'm@test.dev');
    expect((await send(app, 'GET', '/me', undefined, m.cookie)).status).toBe(200);
    const res = await send(app, 'PATCH', `/w/clubhack/members/${m.id}`, { deactivated: true }, ownerCookie);
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT deactivated_at FROM workspace_members WHERE user_id = ?').bind(m.id).first<{ deactivated_at: number }>();
    expect(row!.deactivated_at).toBe(1_800_000_000_000);
    expect((await send(app, 'GET', '/me', undefined, m.cookie)).status).toBe(401);
    const back = await send(app, 'PATCH', `/w/clubhack/members/${m.id}`, { deactivated: false }, ownerCookie);
    expect(back.status).toBe(200);
  });

  it('owner cannot be deactivated or demoted (403)', async () => {
    const { app, sent, ownerCookie } = await setup();
    const ownerId = ((await (await send(app, 'GET', '/me', undefined, ownerCookie)).json()) as Me).id;
    const a = await send(app, 'PATCH', `/w/clubhack/members/${ownerId}`, { deactivated: true }, ownerCookie);
    expect(a.status).toBe(403);
    const b = await send(app, 'PATCH', `/w/clubhack/members/${ownerId}`, { role: 'member' }, ownerCookie);
    expect(b.status).toBe(403);
    // an admin can't touch the owner either
    const m = await joinVia(app, sent, ownerCookie, 'adm@test.dev');
    await send(app, 'PATCH', `/w/clubhack/members/${m.id}`, { role: 'admin' }, ownerCookie);
    expect((await send(app, 'PATCH', `/w/clubhack/members/${ownerId}`, { deactivated: true }, m.cookie)).status).toBe(403);
  });

  it('admin (non-owner) cannot change roles (403)', async () => {
    const { app, sent, ownerCookie } = await setup();
    const a = await joinVia(app, sent, ownerCookie, 'adm@test.dev');
    const b = await joinVia(app, sent, ownerCookie, 'b@test.dev');
    const promote = await send(app, 'PATCH', `/w/clubhack/members/${a.id}`, { role: 'admin' }, ownerCookie);
    expect(promote.status).toBe(200);
    expect(((await promote.json()) as MemberSummary).role).toBe('admin');
    expect((await send(app, 'PATCH', `/w/clubhack/members/${b.id}`, { role: 'admin' }, a.cookie)).status).toBe(403);
    // admin may deactivate a member, but not themselves
    expect((await send(app, 'PATCH', `/w/clubhack/members/${a.id}`, { deactivated: true }, a.cookie)).status).toBe(403);
    expect((await send(app, 'PATCH', `/w/clubhack/members/${b.id}`, { deactivated: true }, a.cookie)).status).toBe(200);
    expect((await send(app, 'PATCH', '/w/clubhack/members/ghost', { deactivated: true }, ownerCookie)).status).toBe(404);
  });
});
