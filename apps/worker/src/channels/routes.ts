import { Hono } from 'hono';
import { ChannelCreateBody, ChannelMembersBody, ChannelPatchBody, DmOpenBody } from '@backroom/protocol';
import type { AppEnv } from '../app';
import type { Env } from '../env';
import { ApiError } from '../lib/errors';
import { hubFor } from '../hub/client';
import type { MembershipChange } from '../hub/WorkspaceHub';
import { readJson } from '../lib/http';
import { requireSession } from '../middleware/session';
import { requireMember } from '../workspace/access';
import { activeMemberIds, addMembers, channelSummaryFor, memberSummariesFor, createChannel, joinChannel, leaveChannel, listChannels, patchChannel } from './channels';
import { openDm } from './dms';

export const channelRoutes = new Hono<AppEnv>();

/**
 * Sends `membership added` to users who are (now) members of the channel, each with their own
 * summary, so a repeated frame to an existing member never resets their unread/mention counts.
 */
async function pushAdded(env: Env, workspaceId: string, channelId: string, userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  const [channel, perUser] = await Promise.all([
    channelSummaryFor(env.DB, channelId),
    memberSummariesFor(env.DB, channelId, userIds),
  ]);
  await hubFor(env, workspaceId).membershipChanged({ action: 'added', userIds, channel, perUser });
}

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

/** Best effort: removes the channel from the caller's own sockets only, so it reveals nothing. */
async function repairLeave(env: Env, channelId: string, removed: MembershipChange): Promise<void> {
  try {
    const row = await env.DB.prepare('SELECT workspace_id AS w FROM channels WHERE id = ?').bind(channelId).first<{ w: string }>();
    if (row) await hubFor(env, row.w).membershipChanged(removed);
  } catch {
    console.error(JSON.stringify({ level: 'error', code: 'leave_repair_failed' }));
  }
}

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
    await pushAdded(c.env, workspaceId, channelId, await activeMemberIds(c.env.DB, channelId));
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
  let workspaceId: string;
  try {
    ({ workspaceId } = await leaveChannel(c.env.DB, channelId, userId, (w) => hubFor(c.env, w).membershipChanged(removed)));
  } catch (e) {
    // A retry after the post-delete hub call failed lands here (the private channel is no longer
    // visible). Still drop it from the caller's own sockets, then answer with the identical 404.
    if (e instanceof ApiError && e.status === 404) c.executionCtx.waitUntil(repairLeave(c.env, channelId, removed));
    throw e;
  }
  await hubFor(c.env, workspaceId).membershipChanged(removed);
  return c.json({ ok: true });
});

channelRoutes.post('/channels/:id/members', requireSession, async (c) => {
  const channelId = c.req.param('id');
  const { userIds } = ChannelMembersBody.parse(await readJson(c));
  const { added, members, workspaceId } = await addMembers(c.env.DB, channelId, c.var.session!.userId, userIds, c.var.deps.now());
  await pushAdded(c.env, workspaceId, channelId, members);
  return c.json({ added });
});

channelRoutes.post('/w/:slug/dms', requireSession, async (c) => {
  const userId = c.var.session!.userId;
  const { workspaceId } = await requireMember(c.env.DB, c.req.param('slug'), userId);
  const { userIds } = DmOpenBody.parse(await readJson(c));
  const { channel, created, participants } = await openDm(c.env.DB, workspaceId, userId, userIds, c.var.deps.now());
  if (created) await hubFor(c.env, workspaceId).membershipChanged({ action: 'added', userIds: participants, channel });
  else await pushAdded(c.env, workspaceId, channel.id, participants);
  return c.json({ channel }, created ? 201 : 200);
});
