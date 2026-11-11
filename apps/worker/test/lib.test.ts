import { env } from 'cloudflare:test';
import { it, expect } from 'vitest';
import { newId } from '../src/lib/ids';
import { randomToken, sha256Hex } from '../src/lib/crypto';
import { hitRateLimit } from '../src/lib/rateLimit';

it('newId is 26 chars and sorts by time', () => {
  const a = newId(1_000), b = newId(2_000);
  expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  expect(a < b).toBe(true);
});
it('randomToken is 43 base64url chars and unique', () => {
  const t = randomToken();
  expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(randomToken()).not.toBe(t);
});
it('sha256Hex matches known vector', async () => {
  expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
it('rate limit allows `limit` hits per window then blocks, and resets', async () => {
  const r = [];
  for (let i = 0; i < 6; i++) r.push(await hitRateLimit(env.DB, 'k', 5, 3_600_000, 1_000));
  expect(r).toEqual([true, true, true, true, true, false]);
  expect(await hitRateLimit(env.DB, 'k', 5, 3_600_000, 1_000 + 3_600_000)).toBe(true);
});
