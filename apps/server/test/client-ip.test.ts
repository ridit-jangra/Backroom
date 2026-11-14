import { type IncomingMessage, createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { ORIGIN_SECRET_HEADER, applyClientIp, normalizeIp, originSecretMatches, trustedClientIp } from '../src/client-ip';
import { listenLocal } from './helpers';

describe('normalizeIp', () => {
  it('accepts IPv4 and IPv6, unwraps IPv4-mapped addresses, refuses everything else', () => {
    expect(normalizeIp('203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeIp(' 2001:db8::1 ')).toBe('2001:db8::1');
    expect(normalizeIp('::ffff:198.51.100.2')).toBe('198.51.100.2');
    expect(normalizeIp('::1')).toBe('::1');
    for (const bad of [undefined, '', 'unknown', '1.2.3', '1.2.3.4:80', 'evil, 1.2.3.4', '<script>']) expect(normalizeIp(bad)).toBeNull();
  });
});

describe('trustedClientIp', () => {
  const spoofed = { 'cf-connecting-ip': '6.6.6.6', 'x-forwarded-for': '7.7.7.7', 'x-real-ip': '8.8.8.8' };

  it('without a trusted header: the socket address, whatever the request claims', () => {
    expect(trustedClientIp(spoofed, '::ffff:127.0.0.1', null)).toBe('127.0.0.1');
    expect(trustedClientIp(spoofed, '192.0.2.10', null)).toBe('192.0.2.10');
    expect(trustedClientIp({}, undefined, null)).toBe('unknown');
  });

  it('cf-connecting-ip trusted: its value', () => {
    expect(trustedClientIp(spoofed, '10.0.0.2', 'cf-connecting-ip')).toBe('6.6.6.6');
  });

  it('x-forwarded-for trusted: the last hop (the address your own proxy saw), across repeated headers', () => {
    expect(trustedClientIp({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }, '10.0.0.2', 'x-forwarded-for')).toBe('2.2.2.2');
    expect(trustedClientIp({ 'x-forwarded-for': ['1.1.1.1', '3.3.3.3'] }, '10.0.0.2', 'x-forwarded-for')).toBe('3.3.3.3');
  });

  it('x-forwarded-for: only the last hop is parsed, so junk written earlier by the client cannot void it', () => {
    expect(trustedClientIp({ 'x-forwarded-for': 'garbage, <script>, 2.2.2.2' }, '10.0.0.2', 'x-forwarded-for')).toBe('2.2.2.2');
    expect(trustedClientIp({ 'x-forwarded-for': ['not an ip', ' 2001:db8::7 '] }, '10.0.0.2', 'x-forwarded-for')).toBe('2001:db8::7');
    expect(trustedClientIp({ 'x-forwarded-for': '1.1.1.1,' }, '10.0.0.2', 'x-forwarded-for')).toBe('10.0.0.2');
  });

  it('a configured header that is missing, repeated or malformed falls back to the socket address', () => {
    expect(trustedClientIp({}, '10.0.0.2', 'cf-connecting-ip')).toBe('10.0.0.2');
    expect(trustedClientIp({ 'cf-connecting-ip': ['1.1.1.1', '2.2.2.2'] }, '10.0.0.2', 'cf-connecting-ip')).toBe('10.0.0.2');
    expect(trustedClientIp({ 'cf-connecting-ip': 'garbage' }, '10.0.0.2', 'cf-connecting-ip')).toBe('10.0.0.2');
    expect(trustedClientIp({ 'x-forwarded-for': '1.1.1.1, nonsense' }, '10.0.0.2', 'x-forwarded-for')).toBe('10.0.0.2');
  });
});

describe('applyClientIp on real requests', () => {
  let close: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await close?.();
    close = null;
  });

  /** Starts a server that applies the rule and reports what the app would see. */
  async function serve(trusted: string | null, secret: string | null = null) {
    const seen: { headers: Record<string, unknown>; raw: string[] }[] = [];
    const record = (req: IncomingMessage) => {
      applyClientIp(req, trusted, secret);
      seen.push({ headers: { ...req.headers }, raw: [...req.rawHeaders] });
    };
    const server = createServer((req, res) => {
      record(req);
      res.end('ok');
    });
    server.on('upgrade', (req, socket) => {
      record(req);
      socket.end('HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
    });
    const port = await listenLocal(server);
    close = () => {
      server.closeAllConnections();
      return new Promise((r) => server.close(() => r()));
    };
    return { port, seen };
  }

  const rawValues = (raw: string[], name: string) => raw.filter((_, i) => i % 2 === 1 && raw[i - 1]!.toLowerCase() === name);

  it('a spoofed CF-Connecting-IP and X-Forwarded-For are replaced by the socket address', async () => {
    const { port, seen } = await serve(null);
    await fetch(`http://127.0.0.1:${port}/auth/start`, { headers: { 'CF-Connecting-IP': '6.6.6.6', 'X-Forwarded-For': '7.7.7.7' } });
    expect(seen[0]!.headers['cf-connecting-ip']).toBe('127.0.0.1');
    expect(rawValues(seen[0]!.raw, 'cf-connecting-ip')).toEqual(['127.0.0.1']);
  });

  it('several spoofed CF-Connecting-IP headers are all removed', async () => {
    const { port, seen } = await serve(null);
    const headers = new Headers();
    headers.append('cf-connecting-ip', '6.6.6.6');
    headers.append('CF-Connecting-IP', '5.5.5.5');
    await fetch(`http://127.0.0.1:${port}/`, { headers });
    expect(rawValues(seen[0]!.raw, 'cf-connecting-ip')).toEqual(['127.0.0.1']);
  });

  it('repeated header lines on the wire (fetch would merge them) are all removed without throwing', async () => {
    const { port, seen } = await serve(null);
    const { connect } = await import('node:net');
    await new Promise<void>((resolve) => {
      const s = connect(port, '127.0.0.1', () =>
        s.write('GET / HTTP/1.1\r\nHost: x\r\nCF-Connecting-IP: 6.6.6.6\r\nCF-Connecting-IP: 5.5.5.5\r\ncf-connecting-ip: 4.4.4.4\r\nConnection: close\r\n\r\n'),
      );
      s.on('data', () => {});
      s.on('close', () => resolve());
    });
    expect(seen[0]!.headers['cf-connecting-ip']).toBe('127.0.0.1');
    expect(rawValues(seen[0]!.raw, 'cf-connecting-ip')).toEqual(['127.0.0.1']);
  });

  it('a configured trusted header is honoured', async () => {
    const { port, seen } = await serve('x-real-ip');
    await fetch(`http://127.0.0.1:${port}/`, { headers: { 'X-Real-IP': '203.0.113.9', 'CF-Connecting-IP': '6.6.6.6' } });
    expect(seen[0]!.headers['cf-connecting-ip']).toBe('203.0.113.9');
    expect(rawValues(seen[0]!.raw, 'cf-connecting-ip')).toEqual(['203.0.113.9']);
  });

  it('the same rules apply to upgrade requests', async () => {
    const { port, seen } = await serve(null);
    const { connect } = await import('node:net');
    await new Promise<void>((resolve) => {
      const s = connect(port, '127.0.0.1', () => {
        s.write(
          'GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nCF-Connecting-IP: 6.6.6.6\r\nX-Forwarded-For: 7.7.7.7\r\n\r\n',
        );
      });
      s.on('data', () => {});
      s.on('close', () => resolve());
    });
    expect(seen[0]!.headers['cf-connecting-ip']).toBe('127.0.0.1');
    expect(rawValues(seen[0]!.raw, 'cf-connecting-ip')).toEqual(['127.0.0.1']);
  });
});

describe('TRUSTED_PROXY_SECRET', () => {
  const SECRET = 'a-very-long-origin-secret-0123456789';

  it('originSecretMatches: exactly one header with exactly the secret', () => {
    expect(originSecretMatches([SECRET], SECRET)).toBe(true);
    expect(originSecretMatches([], SECRET)).toBe(false);
    expect(originSecretMatches(['wrong'], SECRET)).toBe(false);
    expect(originSecretMatches([`${SECRET}x`], SECRET)).toBe(false);
    expect(originSecretMatches([SECRET.slice(0, -1)], SECRET)).toBe(false);
    expect(originSecretMatches([SECRET, SECRET], SECRET)).toBe(false);
  });

  let close: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await close?.();
    close = null;
  });

  async function serve() {
    const seen: Record<string, unknown>[] = [];
    const record = (req: IncomingMessage) => {
      applyClientIp(req, 'cf-connecting-ip', SECRET);
      seen.push({ ...req.headers, raw: [...req.rawHeaders] });
    };
    const server = createServer((req, res) => {
      record(req);
      res.end('ok');
    });
    server.on('upgrade', (req, socket) => {
      record(req);
      socket.end('HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
    });
    const port = await listenLocal(server);
    close = () => {
      server.closeAllConnections();
      return new Promise((r) => server.close(() => r()));
    };
    return { port, seen };
  }

  const cases: [string, Record<string, string>, string][] = [
    ['absent', {}, '127.0.0.1'],
    ['wrong', { 'X-Backroom-Origin-Secret': 'not-the-secret-but-24-chars-long' }, '127.0.0.1'],
    ['right', { 'X-Backroom-Origin-Secret': SECRET }, '6.6.6.6'],
  ];

  it.each(cases)('plain request, secret %s: the trusted header counts only with the right secret; the secret is stripped', async (_n, extra, want) => {
    const { port, seen } = await serve();
    await fetch(`http://127.0.0.1:${port}/auth/start`, { headers: { 'CF-Connecting-IP': '6.6.6.6', ...extra } });
    expect(seen[0]!['cf-connecting-ip']).toBe(want);
    expect(seen[0]![ORIGIN_SECRET_HEADER]).toBeUndefined();
    expect(JSON.stringify(seen[0])).not.toContain(SECRET);
  });

  it.each(cases)('upgrade request, secret %s: same rule', async (_n, extra, want) => {
    const { port, seen } = await serve();
    const { connect } = await import('node:net');
    const lines = Object.entries(extra).map(([k, v]) => `${k}: ${v}\r\n`).join('');
    await new Promise<void>((resolve) => {
      const s = connect(port, '127.0.0.1', () =>
        s.write(`GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nCF-Connecting-IP: 6.6.6.6\r\n${lines}\r\n`),
      );
      s.on('data', () => {});
      s.on('close', () => resolve());
    });
    expect(seen[0]!['cf-connecting-ip']).toBe(want);
    expect(JSON.stringify(seen[0])).not.toContain(SECRET);
  });
});
