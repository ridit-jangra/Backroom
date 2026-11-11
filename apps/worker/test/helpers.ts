import type { Deps } from '../src/app';

export function testDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    mailer: { sendMagicLink: async () => {} },
    now: () => 1_800_000_000_000,
    ...overrides,
  };
}

import { env } from 'cloudflare:test';
import type { Hono } from 'hono';
import type { AppEnv } from '../src/app';
import type { Mailer } from '../src/auth/mailer';

export function captureMailer(): { mailer: Mailer; sent: { to: string; url: string }[] } {
  const sent: { to: string; url: string }[] = [];
  return {
    mailer: {
      async sendMagicLink(_env, to, url) {
        sent.push({ to, url });
      },
    },
    sent,
  };
}

export function post(app: Hono<AppEnv>, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return Promise.resolve(
    app.request(
      path,
      {
        method: 'POST',
        headers: { Origin: 'https://app.test', 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      },
      env,
    ),
  );
}

/** start -> captured link -> verify; returns the Cookie header value. */
export async function signIn(
  app: Hono<AppEnv>,
  sent: { to: string; url: string }[],
  email: string,
  inviteToken?: string,
): Promise<string> {
  const before = sent.length;
  await post(app, '/auth/start', { email, inviteToken });
  if (sent.length !== before + 1) throw new Error('no magic link sent');
  const token = new URL(sent[sent.length - 1]!.url).searchParams.get('t')!;
  const res = await post(app, '/auth/verify', { token });
  if (res.status !== 200) throw new Error(`verify failed: ${res.status}`);
  return res.headers.get('Set-Cookie')!.split(';')[0]!;
}
