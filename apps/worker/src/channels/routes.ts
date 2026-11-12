import { Hono } from 'hono';
import { ChannelCreateBody, ChannelMembersBody, ChannelPatchBody, DmOpenBody } from '@backroom/protocol';
import type { AppEnv } from '../app';
import { hubFor } from '../hub/client';
import type { MembershipChange } from '../hub/WorkspaceHub';
import { readJson } from '../lib/http';
import { requireSession } from '../middleware/session';
import { requireMember } from '../workspace/access';
import { activeMemberIds, addMembers, channelSummaryFor, createChannel, joinChannel, leaveChannel, listChannels, patchChannel } from './channels';
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

/*
 * Hub updates are idempotent (addChannel/removeChannel), so every successful request sends one even
 * when it changed nothing in D1: a retry after a failed hub call then repairs the sockets (a leaver
 * must stop receiving the channel). Clients treat repeated membership frames idempotently.
 */

channelRoutes.patch('/channels/:id', requireSession, async (c) => {
  const patch = ChannelPatchBody.parse(await readJson(c));
  const channelId = c.req.param('id');
  const { channel, workspaceId } = await patchChannel(c.env.DB, channelId, c.var.session!.userId, patch, c.var.deps.now());
  const hub = hubFor(c.env, workspaceId);
  if (patch.archived === false) {
    // Sockets that connected while it was archived do not carry the channel; give it back first so
    // they also receive the channel.update below.
    const userIds = await activeMemberIds(c.env.DB, channelId);
    if (userIds.length > 0) {
      await hub.membershipChanged({ action: 'added', userIds, channel: await channelSummaryFor(c.env.DB, channelId) });
    }
  }
  await hub.channelUpdated(channel);
  return c.json({ channel });
});

channelRoutes.post('/channels/:id/join', requireSession, async (c) => {
  const userId = c.var.session!.userId;
  const { channel, workspaceId } = await joinChannel(c.env.DB, c.req.param('id'), userId, c.var.deps.now());
  await hubFor(c.env, workspaceId).membershipChanged({ action: 'added', userIds: [userId], channel });
  return c.json({ channel });
});

channelRoutes.post('/channels/:id/leave', requireSession, async (c) => {
  const userId = c.var.session!.userId;
  const channelId = c.req.param('id');
  // Sockets are updated before the D1 delete: if the hub call fails nothing has changed and a retry
  // (still a member, so the channel stays visible) works. The second call covers a socket that
  // connected, and read the old membership, between the first call and the delete.
  const removed: MembershipChange = { action: 'removed', userIds: [userId], channelId };
  const { workspaceId } = await leaveChannel(c.env.DB, channelId, userId, (w) => hubFor(c.env, w).membershipChanged(removed));
  await hubFor(c.env, workspaceId).membershipChanged(removed);
  return c.json({ ok: true });
});

channelRoutes.post('/channels/:id/members', requireSession, async (c) => {
  const channelId = c.req.param('id');
  const { userIds } = ChannelMembersBody.parse(await readJson(c));
  const { added, members, workspaceId } = await addMembers(c.env.DB, channelId, c.var.session!.userId, userIds, c.var.deps.now());
  const channel = await channelSummaryFor(c.env.DB, channelId);
  await hubFor(c.env, workspaceId).membershipChanged({ action: 'added', userIds: members, channel });
  return c.json({ added });
});

channelRoutes.post('/w/:slug/dms', requireSession, async (c) => {
  const userId = c.var.session!.userId;
  const { workspaceId } = await requireMember(c.env.DB, c.req.param('slug'), userId);
  const { userIds } = DmOpenBody.parse(await readJson(c));
  const { channel, created, participants } = await openDm(c.env.DB, workspaceId, userId, userIds, c.var.deps.now());
  const pushed = created ? channel : await channelSummaryFor(c.env.DB, channel.id);
  await hubFor(c.env, workspaceId).membershipChanged({ action: 'added', userIds: participants, channel: pushed });
  return c.json({ channel }, created ? 201 : 200);
});
