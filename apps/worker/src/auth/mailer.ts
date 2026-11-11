import type { Env } from '../env';
import { ApiError } from '../lib/errors';

export interface Mailer {
  sendMagicLink(env: Env, to: string, url: string): Promise<void>;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export const resendMailer: Mailer = {
  async sendMagicLink(env, to, url) {
    const text = `Sign in to Backroom: ${url}\n\nThis link expires in 15 minutes and works once.`;
    const html = `<p><a href="${escapeHtml(url)}">Sign in to Backroom</a></p><p>This link expires in 15 minutes and works once.</p>`;
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject: 'Your Backroom sign-in link', text, html }),
    });
    if (!res.ok) throw new ApiError(500, 'email_failed', 'Could not send email.');
  },
};

// Dev only: prints the link instead of emailing it. This is the single place a
// sign-in token is allowed to be logged; only selected when RESEND_API_KEY === 'dev'.
export const consoleMailer: Mailer = {
  async sendMagicLink(_env, to, url) {
    console.log(`Sign-in link for ${to}: ${url}`);
  },
};

export function pickMailer(env: Env): Mailer {
  return env.RESEND_API_KEY === 'dev' ? consoleMailer : resendMailer;
}
