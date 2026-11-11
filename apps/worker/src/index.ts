import { createApp } from './app';
import { resendMailer } from './auth/mailer';
import type { Env } from './env';

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return createApp({ mailer: resendMailer, now: Date.now }).fetch(req, env, ctx);
  },
};
