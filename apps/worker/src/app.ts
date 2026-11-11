import { Hono } from 'hono';
import type { Env } from './env';
import type { SessionInfo } from './auth/sessions';
import type { Mailer } from './auth/mailer';
import { authRoutes } from './auth/routes';
import { errorHandler } from './lib/errors';
import { requireSameOrigin } from './middleware/origin';
import { loadSession } from './middleware/session';
import { workspaceRoutes } from './workspace/routes';


export interface Deps {
  mailer: Mailer;
  now: () => number;
}

export type AppEnv = { Bindings: Env; Variables: { deps: Deps; session?: SessionInfo } };

export function createApp(deps: Deps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.onError(errorHandler);
  app.use('*', requireSameOrigin);
  app.use('*', async (c, next) => {
    c.set('deps', deps);
    await next();
  });
  app.use('*', loadSession);

  app.get('/health', (c) => c.json({ ok: true }));

  app.route('/auth', authRoutes);
  app.route('/', workspaceRoutes);

  return app;
}
