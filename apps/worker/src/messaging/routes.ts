import { Hono } from 'hono';
import { HistoryQuery } from '@backroom/protocol';
import type { AppEnv } from '../app';
import { ApiError } from '../lib/errors';
import { requireSession } from '../middleware/session';
import { getThread, listMessages, requireChannelRead } from './read';

export const messagingRoutes = new Hono<AppEnv>();

messagingRoutes.get('/channels/:id/messages', requireSession, async (c) => {
  const id = c.req.param('id');
  await requireChannelRead(c.env.DB, id, c.var.session!.userId);
  const q = HistoryQuery.parse(c.req.query());
  return c.json(await listMessages(c.env.DB, id, q));
});

messagingRoutes.get('/messages/:id/thread', requireSession, async (c) => {
  // Same body whether the message is missing, a reply, or in a channel the caller cannot see.
  const notFound = () => new ApiError(404, 'not_found', 'Message not found.');
  const page = await getThread(c.env.DB, c.req.param('id'));
  if (!page) throw notFound();
  await requireChannelRead(c.env.DB, page.parent.channelId, c.var.session!.userId).catch(() => {
    throw notFound();
  });
  return c.json(page);
});
