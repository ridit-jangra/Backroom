const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** ULID: 10 chars Crockford base32 timestamp + 16 chars of randomness. */
export function newId(now: number = Date.now()): string {
  let t = now;
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let rand = '';
  for (const b of bytes) rand += ALPHABET[b & 31];
  return time + rand;
}
