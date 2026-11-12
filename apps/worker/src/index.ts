import { createApp } from './app';
import { pickMailer } from './auth/mailer';
import type { Env } from './env';
import { cleanupOrphans } from './files/cleanup';

export { WorkspaceHub } from './hub/WorkspaceHub';

export default {
  fetch(req, env, ctx) {
    return createApp({ mailer: pickMailer(env), now: Date.now }).fetch(req, env, ctx);
  },
  scheduled(controller, env, ctx): void {
    ctx.waitUntil(
      cleanupOrphans(env, controller.scheduledTime).catch(() =>
        console.error(JSON.stringify({ level: 'error', code: 'orphan_cleanup_failed' })),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
