import { Hono } from 'hono';
import { ChannelCreateBody, ChannelMembersBody, ChannelPatchBody, DmOpenBody } from '@backroom/protocol';
import type { AppEnv } from '../app';
import { hubFor } from '../hub/client';
import { readJson } from '../lib/http';
import { requireSession } from '../middleware/session';
import { requireMember } from '../workspace/access';
import { addMembers, channelSummaryFor, createChannel, joinChannel, leaveChannel, listChannels, patchChannel } from './channels';
import { openDm } from './dms';

export const channelRoutes = new Hono<AppEnv>();

channelRoutes.get('/w/:slug/channels', requireSession, async (c) => {
  const userId = c.var.session!.userId;
  const { workspaceId } = await requireMember(c.env.DB, c.req.param('slug'), userId);
  return c.json({ channels: await listChannels(c.env.DB, workspaceId, userId) });
});

channelRoutes.post('/w/:slug/channels', requireSession, async (c) => {
  const userId = c.var.session!.userId;
  const { workspaceId } = await requireMember(c.env.DB, c.req.param('slug'), userId);
  const body = ChannelCreateBody.parse(await readJson(c));
  const channel = await createChannel(c.env.DB, workspaceId, userId, body, c.var.deps.now());
  await hubFor(c.env, workspaceId).membershipChanged({ action: 'added', userIds: [userId], channel });
  return c.json({ channel }, 201);
});

channelRoutes.patch('/channels/:id', requireSession, async (c) => {
  const patch = ChannelPatchBody.parse(await readJson(c));
  const { channel, workspaceId } = await patchChannel(c.env.DB, c.req.param('id'), c.var.session!.userId, patch, c.var.deps.now());
  await hubFor(c.env, workspaceId).channelUpdated(channel);
  return c.json({ channel });
});

channelRoutes.post('/channels/:id/join', requireSession, async (c) => {
  const userId = c.var.session!.userId;
  const { channel, joined, workspaceId } = await joinChannel(c.env.DB, c.req.param('id'), userId, c.var.deps.now());
  if (joined) await hubFor(c.env, workspaceId).membershipChanged({ action: 'added', userIds: [userId], channel });
  return c.json({ channel });
});

channelRoutes.post('/channels/:id/leave', requireSession, async (c) => {
  const userId = c.var.session!.userId;
  const channelId = c.req.param('id');
  const { left, workspaceId } = await leaveChannel(c.env.DB, channelId, userId);
  if (left) await hubFor(c.env, workspaceId).membershipChanged({ action: 'removed', userIds: [userId], channelId });
  return c.json({ ok: true });
});

channelRoutes.post('/channels/:id/members', requireSession, async (c) => {
  const channelId = c.req.param('id');
  const { userIds } = ChannelMembersBody.parse(await readJson(c));
  const { added, workspaceId } = await addMembers(c.env.DB, channelId, c.var.session!.userId, userIds, c.var.deps.now());
  if (added.length > 0) {
    const channel = await channelSummaryFor(c.env.DB, channelId);
    await hubFor(c.env, workspaceId).membershipChanged({ action: 'added', userIds: added, channel });
  }
  return c.json({ added });
});

channelRoutes.post('/w/:slug/dms', requireSession, async (c) => {
  const userId = c.var.session!.userId;
  const { workspaceId } = await requireMember(c.env.DB, c.req.param('slug'), userId);
  const { userIds } = DmOpenBody.parse(await readJson(c));
  const { channel, created, participants } = await openDm(c.env.DB, workspaceId, userId, userIds, c.var.deps.now());
  if (created) {
    await hubFor(c.env, workspaceId).membershipChanged({ action: 'added', userIds: participants, channel });
  }
  return c.json({ channel }, created ? 201 : 200);
});
