import { createApp } from './app';
import { pickMailer } from './auth/mailer';
import type { Env } from './env';

export { WorkspaceHub } from './hub/WorkspaceHub';

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return createApp({ mailer: pickMailer(env), now: Date.now }).fetch(req, env, ctx);
  },
};
