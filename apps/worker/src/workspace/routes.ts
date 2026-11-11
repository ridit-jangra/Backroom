import { Hono } from 'hono';
import { MePatchBody } from '@backroom/protocol';
import type { AppEnv } from '../app';
import { readJson } from '../lib/http';
import { requireSession } from '../middleware/session';
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
