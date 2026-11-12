import { Hono } from 'hono';
import { InviteCreateBody, MemberPatchBody, MePatchBody, WorkspaceSettingsPatchBody } from '@backroom/protocol';
import type { AppEnv } from '../app';
import { readJson } from '../lib/http';
import { requireSession } from '../middleware/session';
import { hubFor } from '../hub/client';
import { ApiError } from '../lib/errors';
import { readSettings } from '../emoji/custom';
import { requireAdmin, requireMember } from './access';
import { createInvite, listInvites, listMembers, patchMember, revokeInvite } from './invites';
import { getBootstrap, getMe } from './bootstrap';

export const workspaceRoutes = new Hono<AppEnv>();

workspaceRoutes.get('/w/:slug/bootstrap', requireSession, async (c) => {
  return c.json(await getBootstrap(c.env.DB, c.req.param('slug'), c.var.session!.userId));
});

workspaceRoutes.get('/me', requireSession, async (c) => c.json(await getMe(c.env.DB, c.var.session!.userId)));

workspaceRoutes.patch('/me', requireSession, async (c) => {
  const { displayName } = MePatchBody.parse(await readJson(c));
  const userId = c.var.session!.userId;
  await c.env.DB.prepare('UPDATE users SET display_name = ? WHERE id = ?').bind(displayName, userId).run();
  return c.json(await getMe(c.env.DB, userId));
});

workspaceRoutes.post('/w/:slug/invites', requireSession, async (c) => {
  const userId = c.var.session!.userId;
  const { workspaceId } = await requireAdmin(c.env.DB, c.req.param('slug'), userId);
  const opts = InviteCreateBody.parse(await readJson(c));
  const { invite, token } = await createInvite(c.env.DB, workspaceId, userId, opts, c.var.deps.now());
  return c.json({ invite, url: `${c.env.APP_ORIGIN}/invite/${token}` }, 201);
});

workspaceRoutes.get('/w/:slug/invites', requireSession, async (c) => {
  const { workspaceId } = await requireAdmin(c.env.DB, c.req.param('slug'), c.var.session!.userId);
  return c.json({ invites: await listInvites(c.env.DB, workspaceId, c.var.deps.now()) });
});

workspaceRoutes.get('/w/:slug/members', requireSession, async (c) => {
  const { workspaceId } = await requireAdmin(c.env.DB, c.req.param('slug'), c.var.session!.userId);
  return c.json({ members: await listMembers(c.env.DB, workspaceId) });
});

workspaceRoutes.delete('/invites/:id', requireSession, async (c) => {
  await revokeInvite(c.env.DB, c.req.param('id'), c.var.session!.userId, c.var.deps.now());
  return c.json({ ok: true });
});

workspaceRoutes.patch('/w/:slug/members/:userId', requireSession, async (c) => {
  const patch = MemberPatchBody.parse(await readJson(c));
  const slug = c.req.param('slug');
  const actorId = c.var.session!.userId;
  const targetId = c.req.param('userId');
  // patchMember returns only the member, so the hub's workspace comes from the actor's membership (P2-R9).
  const { workspaceId } = await requireMember(c.env.DB, slug, actorId);
  const member = await patchMember(c.env.DB, slug, actorId, targetId, patch, c.var.deps.now());
  if (patch.deactivated === true) await hubFor(c.env, workspaceId).disconnectUser(targetId);
  return c.json(member);
});

workspaceRoutes.patch('/w/:slug/settings', requireSession, async (c) => {
  const { workspaceId, role } = await requireMember(c.env.DB, c.req.param('slug'), c.var.session!.userId);
  if (role !== 'owner') throw new ApiError(403, 'forbidden', 'Only the owner can change workspace settings.');
  const { customEmojiPolicy } = WorkspaceSettingsPatchBody.parse(await readJson(c));
  const row = await c.env.DB.prepare(
    `UPDATE workspaces SET settings_json = json_set(COALESCE(settings_json, '{}'), '$.customEmojiPolicy', ?) WHERE id = ? RETURNING settings_json AS settingsJson`,
  )
    .bind(customEmojiPolicy, workspaceId)
    .first<{ settingsJson: string | null }>();
  return c.json({ settings: readSettings(row?.settingsJson ?? null) });
});
