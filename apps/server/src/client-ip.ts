/**
 * The client IP the app sees (its rate limits read `CF-Connecting-IP`) comes only from a trusted source. Every
 * incoming `CF-Connecting-IP` is removed, then the header is set from the socket address or, when
 * TRUSTED_PROXY_HEADER is configured, from that header as written by the proxy in front of the server.
 */
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';

export const CLIENT_IP_HEADER = 'cf-connecting-ip';
/**
 * Proof that a request came through the operator's own edge (e.g. a Cloudflare Transform Rule adds it): with
 * TRUSTED_PROXY_SECRET set, TRUSTED_PROXY_HEADER is believed only on requests carrying this header with the secret.
 * Always removed before the app sees the request.
 */
export const ORIGIN_SECRET_HEADER = 'x-backroom-origin-secret';

/** Exactly one header value, equal to the secret (constant-time on equal lengths). */
export function originSecretMatches(values: string[], secret: string): boolean {
  if (values.length !== 1) return false;
  const got = Buffer.from(values[0]!, 'utf8');
  const want = Buffer.from(secret, 'utf8');
  if (got.length !== want.length) {
    timingSafeEqual(want, want); // same work either way
    return false;
  }
  return timingSafeEqual(got, want);
}

/** A bare IPv4/IPv6 address (IPv4-mapped IPv6 unwrapped), or null for anything else. */
export function normalizeIp(value: string | undefined): string | null {
  if (value === undefined) return null;
  const v = value.trim();
  if (isIP(v) === 0) return null;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(v);
  return mapped ? mapped[1]! : v;
}

type HeaderBag = Record<string, string | string[] | undefined>;

/** The address the trusted header names, or null when it is missing, repeated, or not an address. */
function fromTrustedHeader(headers: HeaderBag, name: string): string | null {
  const raw = headers[name];
  if (raw === undefined) return null;
  if (name === 'x-forwarded-for') {
    // Each proxy appends the address it saw: only the last entry (written by the proxy next to us) is trusted, and
    // only it is parsed; anything before it came from the client or earlier hops and may be junk.
    const hops = (Array.isArray(raw) ? raw.join(',') : raw).split(',');
    return normalizeIp(hops[hops.length - 1]);
  }
  if (Array.isArray(raw)) return raw.length === 1 ? normalizeIp(raw[0]) : null;
  return normalizeIp(raw);
}

export function trustedClientIp(headers: HeaderBag, remoteAddress: string | undefined, trustedHeader: string | null): string {
  if (trustedHeader) {
    const ip = fromTrustedHeader(headers, trustedHeader);
    if (ip) return ip;
  }
  return normalizeIp(remoteAddress) ?? 'unknown';
}

/** Repeated headers as Node keeps them in `rawHeaders` (`headers` joins or drops duplicates). */
function headerBagFromRaw(raw: string[]): HeaderBag {
  const bag: Record<string, string[]> = {};
  for (let i = 0; i + 1 < raw.length; i += 2) (bag[raw[i]!.toLowerCase()] ??= []).push(raw[i + 1]!);
  return Object.fromEntries(Object.entries(bag).map(([k, v]) => [k, v.length === 1 ? v[0] : v]));
}

/**
 * Rewrites the request's headers in place (both `rawHeaders`, which @hono/node-server reads, and `headers`) so
 * exactly one `cf-connecting-ip` remains, holding the trusted address, and no origin-secret header is left.
 * With `secret` set, `trustedHeader` is honoured only when the request proves the secret. Returns the address.
 */
export function applyClientIp(req: IncomingMessage, trustedHeader: string | null, secret: string | null = null): string {
  // Materialise `headers` BEFORE replacing rawHeaders: Node builds it lazily from rawHeaders using the header count
  // it parsed, so computing it from a shorter replacement array would throw.
  const headers = req.headers;
  const secretValues: string[] = [];
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i]!.toLowerCase() === ORIGIN_SECRET_HEADER) secretValues.push(req.rawHeaders[i + 1]!);
  }
  const effective = secret === null || originSecretMatches(secretValues, secret) ? trustedHeader : null;
  const ip = trustedClientIp(headerBagFromRaw(req.rawHeaders), req.socket?.remoteAddress, effective);
  const raw: string[] = [];
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]!.toLowerCase();
    if (name !== CLIENT_IP_HEADER && name !== ORIGIN_SECRET_HEADER) raw.push(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
  }
  raw.push('CF-Connecting-IP', ip);
  req.rawHeaders = raw;
  delete headers[ORIGIN_SECRET_HEADER];
  delete headers[CLIENT_IP_HEADER];
  headers[CLIENT_IP_HEADER] = ip;
  return ip;
}
