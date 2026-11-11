import { createApp, type Mailer } from './app';
import type { Env } from './env';

// Replaced by the real Resend mailer in Task 10.
const stubMailer: Mailer = {
  async sendMagicLink() {
    throw new Error('email_not_configured');
  },
};

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return createApp({ mailer: stubMailer, now: Date.now }).fetch(req, env, ctx);
  },
};
