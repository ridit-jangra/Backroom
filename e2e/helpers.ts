import fs from 'node:fs';
import zlib from 'node:zlib';
import { expect, type Page } from '@playwright/test';
import { SERVER_LOG, WORKSPACE } from './paths';

const LINK_RE = /^Sign-in link for (\S+): (\S+\/verify\?t=\S+)$/;

function linksFor(email: string): string[] {
  let text = '';
  try {
    text = fs.readFileSync(SERVER_LOG, 'utf8');
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const m = LINK_RE.exec(line.trim());
    if (m && m[1] === email) out.push(m[2]!);
  }
  return out;
}

/**
 * The newest sign-in link the console mailer printed for `email`. The mailer runs off the
 * response path (waitUntil), so this polls until at least `count` links exist for the address.
 * The link itself is never logged.
 */
export async function magicLink(email: string, count = 1): Promise<string> {
  let links: string[] = [];
  await expect
    .poll(() => (links = linksFor(email)).length, { message: `sign-in link for ${email}`, timeout: 15_000 })
    .toBeGreaterThanOrEqual(count);
  return links[links.length - 1]!;
}

/** Signs in through the login page (via the invite link when given) and lands in the workspace. */
export async function signIn(page: Page, email: string, inviteUrl?: string): Promise<void> {
  const before = linksFor(email).length;
  await page.goto(inviteUrl ?? '/login');
  await expect(page).toHaveURL(/\/login(\?|$)/);
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByRole('status')).toContainText('Check your email');
  await page.goto(await magicLink(email, before + 1));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(new RegExp(`/client/${WORKSPACE}/[0-9A-Z]{26}$`));
}

/** The channel id from a workspace URL. */
export function channelIdOf(page: Page): string {
  const m = new RegExp(`/client/${WORKSPACE}/([0-9A-Z]{26})$`).exec(new URL(page.url()).pathname);
  if (!m) throw new Error(`not on a channel URL: ${page.url()}`);
  return m[1]!;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A valid RGB PNG with a gradient; big enough (> 720px) that the client makes a thumbnail. */
export function makePng(width = 1000, height = 800): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = 1 + width * 3;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = y * row + 1 + x * 3;
      raw[o] = (x * 255) / width;
      raw[o + 1] = (y * 255) / height;
      raw[o + 2] = 128;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
