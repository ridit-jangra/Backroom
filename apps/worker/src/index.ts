import { createApp } from './app';
import { pickMailer } from './auth/mailer';
import type { Env } from './env';
import { cleanupOrphans } from './files/cleanup';
import { cleanupAuth } from './maintenance';

export { WorkspaceHub } from './hub/WorkspaceHub';

export default {
  fetch(req, env, ctx) {
    return createApp({ mailer: pickMailer(env), now: Date.now }).fetch(req, env, ctx);
  },
  scheduled(controller, env, ctx): void {
    // Independent jobs: one failing never stops the other.
    ctx.waitUntil(
      cleanupOrphans(env, controller.scheduledTime).catch(() =>
        console.error(JSON.stringify({ level: 'error', code: 'orphan_cleanup_failed' })),
      ),
    );
    ctx.waitUntil(
      cleanupAuth(env.DB, controller.scheduledTime).catch(() =>
        console.error(JSON.stringify({ level: 'error', code: 'auth_cleanup_failed' })),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
