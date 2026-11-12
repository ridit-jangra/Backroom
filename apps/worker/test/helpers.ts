import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import type { Hono } from 'hono';
import type { AppEnv, Deps } from '../src/app';
import type { Mailer } from '../src/auth/mailer';
import { newId } from '../src/lib/ids';

export function testDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    mailer: { sendMagicLink: async () => {} },
    now: () => 1_800_000_000_000,
    ...overrides,
  };
}


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

export async function post(app: Hono<AppEnv>, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.request(
    path,
    {
      method: 'POST',
      headers: { Origin: 'https://app.test', 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    },
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx); // flush waitUntil work (e.g. captured emails)
  return res;
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

const SEED_CHANNELS = ['01JCLUBHACK0000000000000GN', '01JCLUBHACK0000000000000RD'];

/** Clear all application data, keeping the seeded workspace and channels (last_seq reset to 0). */
export async function resetDb(): Promise<void> {
  const tables = [
    'message_files', 'files', 'custom_emoji', 'reactions', 'mentions', 'thread_follows', 'messages',
    'channel_members', 'sessions', 'login_codes', 'login_tokens', 'rate_limits', 'invites',
    'workspace_members', 'users',
  ];
  await env.DB.batch([
    ...tables.map((t) => env.DB.prepare(`DELETE FROM ${t}`)),
    env.DB.prepare(`DELETE FROM channels WHERE id NOT IN (${SEED_CHANNELS.map(() => '?').join(',')})`).bind(...SEED_CHANNELS),
    env.DB.prepare('UPDATE channels SET last_seq = 0, topic = NULL, archived_at = NULL'),
    env.DB.prepare("UPDATE workspaces SET settings_json = '{}'"),
  ]);
  for (;;) {
    const page = await env.BUCKET.list();
    if (page.objects.length > 0) await env.BUCKET.delete(page.objects.map((o) => o.key));
    if (!page.truncated) break;
  }
}

function padTo(header: number[], size?: number): Uint8Array {
  const out = new Uint8Array(Math.max(header.length, size ?? 0));
  out.set(header);
  return out;
}

const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const be16 = (n: number) => [(n >>> 8) & 255, n & 255];
const le16 = (n: number) => [n & 255, (n >>> 8) & 255];

/** PNG signature + IHDR chunk (zero CRC), padded with zeros to `size`. */
export function png(w: number, h: number, size?: number): Uint8Array {
  return padTo(
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), 0x49, 0x48, 0x44, 0x52, ...be32(w), ...be32(h), 8, 6, 0, 0, 0, 0, 0, 0, 0],
    size,
  );
}

/** GIF89a header + logical screen descriptor + trailer. */
export function gif(w: number, h: number): Uint8Array {
  return padTo([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, ...le16(w), ...le16(h), 0, 0, 0, 0x3b]);
}

/** SOI, an APP0 (JFIF) segment, then SOF0 with the dimensions, then EOI. */
export function jpeg(w: number, h: number): Uint8Array {
  const app0 = [0xff, 0xe0, ...be16(16), 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof0 = [0xff, 0xc0, ...be16(17), 8, ...be16(h), ...be16(w), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  return padTo([0xff, 0xd8, ...app0, ...sof0, 0xff, 0xd9]);
}

/** Multipart `POST /w/:slug/emoji` (slug `clubhack`) with `name` and `image`, plus Origin. */
export async function uploadEmoji(
  app: Hono<AppEnv>,
  cookie: string,
  name: string,
  bytes: Uint8Array,
  opts: { filename?: string; type?: string } = {},
): Promise<Response> {
  const form = new FormData();
  form.set('name', name);
  form.set('image', new File([bytes], opts.filename ?? 'emoji.png', { type: opts.type ?? 'image/png' }));
  const ctx = createExecutionContext();
  const res = await app.request(
    '/w/clubhack/emoji',
    { method: 'POST', headers: { Origin: 'https://app.test', Cookie: cookie }, body: form },
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

/** Generic request with Origin; `body` is JSON-encoded when provided. */
export async function send(
  app: Hono<AppEnv>,
  method: string,
  path: string,
  body?: unknown,
  cookie?: string,
): Promise<Response> {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = { Origin: 'https://app.test' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await app.request(
    path,
    { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

export const GENERAL = '01JCLUBHACK0000000000000GN';

/** Sign in the owner (first email must be owner@test.dev) and the rest via one owner-created invite. */
export async function seedUsers(
  app: Hono<AppEnv>,
  sent: { to: string; url: string }[],
  emails: string[],
): Promise<{ email: string; cookie: string; userId: string }[]> {
  if (emails[0] !== 'owner@test.dev') throw new Error('first email must be owner@test.dev');
  const out: { email: string; cookie: string; userId: string }[] = [];
  const whoami = async (cookie: string) =>
    ((await (await send(app, 'GET', '/me', undefined, cookie)).json()) as { id: string }).id;
  const ownerCookie = await signIn(app, sent, emails[0]);
  out.push({ email: emails[0], cookie: ownerCookie, userId: await whoami(ownerCookie) });
  if (emails.length > 1) {
    const res = await send(app, 'POST', '/w/clubhack/invites', { maxUses: emails.length }, ownerCookie);
    const token = ((await res.json()) as { url: string }).url.split('/invite/')[1]!;
    for (const email of emails.slice(1)) {
      const cookie = await signIn(app, sent, email, token);
      out.push({ email, cookie, userId: await whoami(cookie) });
    }
  }
  return out;
}

/** Direct D1 insert of a channel in `clubhack` with the given members (last_read_seq 0). */
export async function insertChannel(opts: {
  name: string | null;
  kind: 'public' | 'private' | 'dm';
  memberIds: string[];
  dmKey?: string;
  createdBy?: string;
}): Promise<string> {
  const id = newId();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO channels (id, workspace_id, name, kind, dm_key, created_by, created_at) VALUES (?, '01JCLUBHACK0000000000000WS', ?, ?, ?, ?, 1)",
    ).bind(id, opts.name, opts.kind, opts.dmKey ?? null, opts.createdBy ?? null),
    ...opts.memberIds.map((u) =>
      env.DB.prepare('INSERT INTO channel_members (channel_id, user_id, last_read_seq, joined_at) VALUES (?, ?, 0, 1)').bind(id, u),
    ),
  ]);
  return id;
}

/** Direct D1 insert of a custom emoji (or alias); returns its id. Workspace defaults to `clubhack`. */
export async function insertCustomEmoji(opts: {
  name: string;
  aliasFor?: string;
  createdBy?: string;
  workspaceId?: string;
}): Promise<string> {
  const id = newId();
  const ws = opts.workspaceId ?? '01JCLUBHACK0000000000000WS';
  await env.DB.prepare(
    'INSERT INTO custom_emoji (id, workspace_id, name, r2_key, alias_for, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 1)',
  )
    .bind(id, ws, opts.name, opts.aliasFor ? null : `ws/${ws}/emoji/${id}`, opts.aliasFor ?? null, opts.createdBy ?? null)
    .run();
  return id;
}
