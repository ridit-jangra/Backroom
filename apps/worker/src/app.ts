import { Hono } from 'hono';
import type { Env } from './env';
import type { SessionInfo } from './auth/sessions';
import { errorHandler } from './lib/errors';
import { requireSameOrigin } from './middleware/origin';
import { loadSession } from './middleware/session';

// Placeholder: Mailer moves to its own module in Task 6.
export interface Mailer {
  sendMagicLink(env: Env, to: string, url: string): Promise<void>;
}

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

  return app;
}
