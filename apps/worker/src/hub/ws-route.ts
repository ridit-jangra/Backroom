import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { ApiError } from '../lib/errors';
import { requireMember } from '../workspace/access';
import { hubFor } from './client';

export const wsRoute = new Hono<AppEnv>();

wsRoute.get('/ws', async (c) => {
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
    throw new ApiError(426, 'upgrade_required', 'WebSocket upgrade required.');
  }
  const session = c.var.session;
  if (!session) throw new ApiError(401, 'unauthenticated', 'Sign in required.');
  // requireSameOrigin skips GETs, so the upgrade checks Origin itself. Browsers always send Origin on
  // WebSocket handshakes, so a cookie session must come from the app; a Bearer client may omit it.
  const origin = c.req.header('Origin');
  const originOk = session.via === 'cookie' ? origin === c.env.APP_ORIGIN : origin === undefined || origin === c.env.APP_ORIGIN;
  if (!originOk) throw new ApiError(403, 'bad_origin', 'Origin not allowed');
  const { workspaceId } = await requireMember(c.env.DB, c.req.query('workspace') ?? '', session.userId);
  // A fresh request: no client header (cookie, Authorization, spoofed X-Backroom-*) reaches the hub.
  return hubFor(c.env, workspaceId).fetch(
    new Request('https://hub/connect', {
      headers: { Upgrade: 'websocket', 'X-Backroom-User': session.userId, 'X-Backroom-Workspace': workspaceId },
    }),
  );
});
