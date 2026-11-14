/**
 * The web app's static files, served the way Workers Static Assets served them (wrangler.jsonc `assets`):
 * - API paths (`run_worker_first`) always go to the app; other GET/HEAD requests are served from the build when a
 *   file matches, and navigations that match nothing get index.html (`single-page-application`); anything else
 *   goes to the app, whose 404 is JSON.
 * - `Cache-Control: public, max-age=0, must-revalidate` (the Workers default) on everything except the
 *   content-hashed files under /assets/, which never change and are cached for a year.
 * - the rules of the build's `_headers` file (Cloudflare format) are applied on top.
 * - paths are decoded once and refused if any segment could step outside the build directory.
 */
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, join, sep } from 'node:path';
import type { Log } from './log';

/** apps/worker/wrangler.jsonc `assets.run_worker_first` (a test keeps the two identical). */
export const API_ROUTES = ['/auth/*', '/me', '/w/*', '/invites/*', '/health', '/channels/*', '/messages/*', '/emoji/*', '/files/*', '/ws'] as const;

export const HTML_CACHE_CONTROL = 'public, max-age=0, must-revalidate';
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export function isApiPath(pathname: string): boolean {
  return API_ROUTES.some((r) => (r.endsWith('/*') ? pathname.startsWith(r.slice(0, -1)) : pathname === r));
}

/** A browser navigation (Sec-Fetch-Mode: navigate, or an HTML Accept from a client without fetch metadata). */
export function isNavigationRequest(req: Request): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const mode = req.headers.get('sec-fetch-mode');
  if (mode !== null) return mode === 'navigate';
  return (req.headers.get('accept') ?? '').includes('text/html');
}

export interface HeaderRule {
  pattern: string;
  set: [string, string][];
  detach: string[];
}

/** RFC 9110 token (header field name). */
const TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Field values may not carry NUL, CR or LF (the fetch Headers class would throw on them). */
const BAD_VALUE_RE = /[\u0000\r\n]/;

/**
 * Parses a Cloudflare `_headers` file. Rules for absolute URLs (other hosts) are ignored. A line whose header name
 * is not a token or whose value holds NUL/CR/LF is skipped and reported through `onInvalid` (1-based line number).
 */
export function parseHeadersFile(text: string, onInvalid: (line: number, reason: string) => void = () => {}): HeaderRule[] {
  const rules: HeaderRule[] = [];
  let current: HeaderRule | null = null;
  let skipping = false;
  const lines = text.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!;
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      const pattern = line.trim();
      skipping = !pattern.startsWith('/');
      current = skipping ? null : { pattern, set: [], detach: [] };
      if (current) rules.push(current);
      continue;
    }
    if (skipping || !current) continue;
    const body = line.trim();
    if (body.startsWith('!')) {
      const name = body.slice(1).trim();
      if (!TOKEN_RE.test(name)) onInvalid(n + 1, 'name');
      else current.detach.push(name.toLowerCase());
      continue;
    }
    const colon = body.indexOf(':');
    if (colon <= 0) {
      onInvalid(n + 1, 'syntax');
      continue;
    }
    const name = body.slice(0, colon).trim();
    const value = body.slice(colon + 1).trim();
    if (!TOKEN_RE.test(name)) onInvalid(n + 1, 'name');
    else if (BAD_VALUE_RE.test(value)) onInvalid(n + 1, 'value');
    else current.set.push([name.toLowerCase(), value]);
  }
  return rules;
}

/** `*` matches anything (also across `/`), `:name` one path segment. */
export function matchesPattern(pattern: string, pathname: string): boolean {
  let re = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '*') re += '.*';
    else if (ch === ':' && /[A-Za-z]/.test(pattern[i + 1] ?? '')) {
      while (/[A-Za-z0-9_]/.test(pattern[i + 1] ?? '')) i++;
      re += '[^/]+';
    } else re += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${re}$`).test(pathname);
}

/**
 * The response headers for `pathname`: `defaults`, then every matching rule in file order. A header set by the
 * rules replaces a default of the same name; values from several matching rules are joined with ", "; a detach
 * (`! Name`) in any matching rule removes the header.
 */
export function headersForPath(rules: HeaderRule[], pathname: string, defaults: [string, string][]): [string, string][] {
  const fromRules = new Map<string, string[]>();
  const detached = new Set<string>();
  for (const r of rules) {
    if (!matchesPattern(r.pattern, pathname)) continue;
    for (const [k, v] of r.set) (fromRules.get(k) ?? fromRules.set(k, []).get(k)!).push(v);
    for (const d of r.detach) detached.add(d);
  }
  const out = new Map<string, string>(defaults);
  for (const [k, vs] of fromRules) out.set(k, vs.join(', '));
  for (const d of detached) out.delete(d);
  return [...out];
}

/**
 * The URL path as a path relative to the build directory, or null if it is unsafe or malformed. Decoded exactly
 * once; refused: bad percent-encoding, NUL or other control characters, backslashes, colons, and `.`/`..` or
 * empty segments. A double-encoded `%252e%252e` stays the literal name `%2e%2e`, which cannot step outside.
 */
export function safeRelativePath(pathname: string): string | null {
  if (!pathname.startsWith('/')) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (/[\u0000-\u001f\u007f\\:]/.test(decoded)) return null;
  const rel = decoded.slice(1);
  if (rel === '') return '';
  const segments = rel.split('/');
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!;
    if (s === '.' || s === '..') return null;
    if (s === '' && i !== segments.length - 1) return null;
  }
  return rel;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/** Files Workers never served from the asset directory. */
function hidden(rel: string): boolean {
  return rel === '_headers' || rel === '_redirects' || rel.split('/').some((s) => s.startsWith('.'));
}

export interface StaticSite {
  /** The matching file as a response, or null when there is none (or the method/path cannot be static). */
  serve(req: Request): Promise<Response | null>;
  /** index.html, for single-page-application navigations. */
  index(req: Request): Promise<Response>;
}

function etagMatches(header: string | null, etag: string): boolean {
  if (header === null) return false;
  if (header.trim() === '*') return true;
  const bare = etag.replace(/^W\//, '');
  return header.split(',').some((t) => t.trim().replace(/^W\//, '') === bare);
}

export async function createStaticSite(root: string, log: Log = () => {}): Promise<StaticSite> {
  const realRoot = await realpath(root).catch(() => root);
  try {
    if (!(await stat(join(realRoot, 'index.html'))).isFile()) throw new Error('not a file');
  } catch {
    throw new Error(`the web build at ${root} has no index.html (build it with: npm run build -w apps/web, or set WEB_DIST)`);
  }
  const rules = parseHeadersFile(await readFile(join(realRoot, '_headers'), 'utf8').catch(() => ''), (line, reason) =>
    log('warn', 'headers_rule_invalid', { line, reason }),
  );

  async function respond(req: Request, rel: string, urlPath: string): Promise<Response | null> {
    const abs = join(realRoot, rel);
    let real: string;
    let size: number;
    let mtimeMs: number;
    try {
      real = await realpath(abs);
      if (!real.startsWith(realRoot + sep)) return null;
      const st = await stat(real);
      if (!st.isFile()) return null;
      size = st.size;
      mtimeMs = st.mtimeMs;
    } catch {
      return null;
    }
    const etag = `W/"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;
    const cache = urlPath.startsWith('/assets/') ? IMMUTABLE_CACHE_CONTROL : HTML_CACHE_CONTROL;
    const headers = new Headers(headersForPath(rules, urlPath, [['cache-control', cache]]));
    headers.set('content-type', contentTypeFor(real));
    headers.set('etag', etag);
    if (etagMatches(req.headers.get('if-none-match'), etag)) return new Response(null, { status: 304, headers });
    headers.set('content-length', String(size));
    if (req.method === 'HEAD') return new Response(null, { status: 200, headers });
    let body: Buffer;
    try {
      body = await readFile(real);
    } catch {
      return null;
    }
    headers.set('content-length', String(body.byteLength));
    return new Response(new Uint8Array(body), { status: 200, headers });
  }

  return {
    async serve(req) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return null;
      const pathname = new URL(req.url).pathname;
      const rel = safeRelativePath(pathname);
      if (rel === null || hidden(rel)) return null;
      if (rel === '') return respond(req, 'index.html', '/');
      if (rel.endsWith('/')) return null;
      return respond(req, rel, pathname);
    },
    async index(req) {
      const r = await respond(req, 'index.html', '/');
      if (!r) throw new Error('index.html is missing from the web build');
      return r;
    },
  };
}
