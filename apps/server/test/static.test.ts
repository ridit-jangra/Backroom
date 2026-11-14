import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  API_ROUTES,
  type StaticSite,
  createStaticSite,
  headersForPath,
  isApiPath,
  isNavigationRequest,
  matchesPattern,
  parseHeadersFile,
  safeRelativePath,
} from '../src/static';
import { WEB_HEADERS, fixtureDist, tempDir } from './helpers';

const here = dirname(fileURLToPath(import.meta.url));

const req = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
  new Request(`http://localhost${path}`, init);
const nav = (path: string) => req(path, { headers: { 'Sec-Fetch-Mode': 'navigate', Accept: 'text/html' } });

describe('API routes (wrangler.jsonc run_worker_first)', () => {
  it('match the list in wrangler.jsonc exactly', () => {
    const jsonc = readFileSync(join(here, '../../worker/wrangler.jsonc'), 'utf8');
    const list = JSON.parse(/"run_worker_first":\s*(\[[^\]]*\])/.exec(jsonc)![1]!) as string[];
    expect([...API_ROUTES]).toEqual(list);
  });

  it.each([
    ['/auth/start', true],
    ['/auth/verify', true],
    ['/me', true],
    ['/w/clubhack/bootstrap', true],
    ['/invites/abc', true],
    ['/health', true],
    ['/channels/x/join', true],
    ['/messages/x', true],
    ['/emoji/x', true],
    ['/files/x', true],
    ['/ws', true],
    ['/', false],
    ['/client/clubhack', false],
    ['/verify', false],
    ['/auth', false],
    ['/mee', false],
    ['/me/x', false],
    ['/healthz', false],
    ['/wsx', false],
    ['/assets/index-AbC123xy.js', false],
  ])('isApiPath(%s) = %s', (p, want) => {
    expect(isApiPath(p)).toBe(want);
  });
});

describe('_headers', () => {
  it('parses the web app _headers file', () => {
    expect(parseHeadersFile(WEB_HEADERS)).toEqual([
      {
        pattern: '/*',
        set: [
          ['x-content-type-options', 'nosniff'],
          ['referrer-policy', 'same-origin'],
          ['x-frame-options', 'DENY'],
        ],
        detach: [],
      },
      { pattern: '/twemoji/*', set: [['cache-control', 'public, max-age=604800']], detach: [] },
    ]);
  });

  it('supports detach lines, placeholders, comments and ignores absolute URL rules', () => {
    const rules = parseHeadersFile(
      '# c\n/blog/:slug/x\n  X-A: 1\n  ! Referrer-Policy\nhttps://example.com/*\n  X-B: 2\n/*\n  Referrer-Policy: same-origin\n  X-A: 2\n',
    );
    expect(rules).toHaveLength(2);
    expect(matchesPattern('/blog/:slug/x', '/blog/hello/x')).toBe(true);
    expect(matchesPattern('/blog/:slug/x', '/blog/a/b/x')).toBe(false);
    expect(matchesPattern('/twemoji/*', '/twemoji/1f600.svg')).toBe(true);
    expect(matchesPattern('/twemoji/*', '/twemojis/1')).toBe(false);
    expect(matchesPattern('/*', '/')).toBe(true);
    const h = headersForPath(rules, '/blog/hello/x', [['cache-control', 'public, max-age=0, must-revalidate']]);
    // Values of one header from several matching rules are joined; a detach removes it from every rule.
    expect(Object.fromEntries(h)).toEqual({ 'cache-control': 'public, max-age=0, must-revalidate', 'x-a': '1, 2' });
  });

  it('a rule replaces a default header of the same name', () => {
    const h = headersForPath(parseHeadersFile(WEB_HEADERS), '/twemoji/1f600.svg', [['cache-control', 'public, max-age=0, must-revalidate']]);
    expect(Object.fromEntries(h)['cache-control']).toBe('public, max-age=604800');
  });
});

describe('safeRelativePath', () => {
  it.each([
    ['/', ''],
    ['/index.html', 'index.html'],
    ['/assets/a%20b.js', 'assets/a b.js'],
    ['/twemoji/1f600.svg', 'twemoji/1f600.svg'],
  ])('%s -> %s', (p, want) => {
    expect(safeRelativePath(p)).toBe(want);
  });

  it.each([
    '/..%2f..%2fetc/passwd',
    '/%2e%2e/',
    '/%2e%2e/%2e%2e/etc/passwd',
    '/assets/..%5c..%5cindex.html',
    '/a%00.js',
    '/%E0%A4%A',
    '/./index.html',
    '/assets/%2e/x',
    '/C:/x',
  ])('%s is rejected', (p) => {
    expect(safeRelativePath(p)).toBeNull();
  });

  it('double encoding is decoded once only (a literal "%2e%2e" name, which cannot escape)', () => {
    expect(safeRelativePath('/%252e%252e/%252e%252e/etc/passwd')).toBe('%2e%2e/%2e%2e/etc/passwd');
  });
});

describe('isNavigationRequest', () => {
  it('Sec-Fetch-Mode navigate, or an HTML Accept without fetch metadata', () => {
    expect(isNavigationRequest(nav('/x'))).toBe(true);
    expect(isNavigationRequest(req('/x', { headers: { Accept: 'text/html,application/xhtml+xml' } }))).toBe(true);
    expect(isNavigationRequest(req('/x', { headers: { Accept: '*/*' } }))).toBe(false);
    expect(isNavigationRequest(req('/x', { headers: { 'Sec-Fetch-Mode': 'cors', Accept: 'text/html' } }))).toBe(false);
    expect(isNavigationRequest(req('/x', { method: 'POST', headers: { 'Sec-Fetch-Mode': 'navigate' } }))).toBe(false);
  });
});

describe('createStaticSite', () => {
  let site: StaticSite;
  let root: string;
  beforeEach(async () => {
    root = fixtureDist();
    site = await createStaticSite(root);
  });

  it('serves files with content types, _headers rules and Workers-like caching', async () => {
    const html = (await site.serve(req('/')))!;
    expect(html.status).toBe(200);
    expect(html.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(html.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
    expect(html.headers.get('x-content-type-options')).toBe('nosniff');
    expect(html.headers.get('referrer-policy')).toBe('same-origin');
    expect(html.headers.get('x-frame-options')).toBe('DENY');
    expect(html.headers.get('etag')).toMatch(/^W\/".+"$/);
    expect(await html.text()).toContain('<div id="root">');

    const js = (await site.serve(req('/assets/index-AbC123xy.js')))!;
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(js.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(js.headers.get('x-frame-options')).toBe('DENY');
    expect(js.headers.get('content-length')).toBe(String('console.log("app")'.length));

    expect((await site.serve(req('/assets/index-AbC123xy.css')))!.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect((await site.serve(req('/assets/font-Zz9.woff2')))!.headers.get('content-type')).toBe('font/woff2');
    expect((await site.serve(req('/favicon.ico')))!.headers.get('content-type')).toBe('image/x-icon');
    expect((await site.serve(req('/robots.txt')))!.headers.get('content-type')).toBe('text/plain; charset=utf-8');

    const svg = (await site.serve(req('/twemoji/1f600.svg')))!;
    expect(svg.headers.get('content-type')).toBe('image/svg+xml');
    expect(svg.headers.get('cache-control')).toBe('public, max-age=604800');
  });

  it('answers If-None-Match with 304 and HEAD without a body', async () => {
    const first = (await site.serve(req('/assets/index-AbC123xy.js')))!;
    const etag = first.headers.get('etag')!;
    const again = (await site.serve(req('/assets/index-AbC123xy.js', { headers: { 'If-None-Match': etag } })))!;
    expect(again.status).toBe(304);
    expect(again.body).toBeNull();
    expect(again.headers.get('etag')).toBe(etag);
    const head = (await site.serve(req('/assets/index-AbC123xy.js', { method: 'HEAD' })))!;
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    expect(head.headers.get('content-length')).toBe(first.headers.get('content-length'));
  });

  it('misses: unknown files, directories, _headers, dotfiles, other methods, traversal', async () => {
    for (const p of [
      '/nope.js',
      '/assets',
      '/assets/',
      '/_headers',
      '/.hidden',
      '/..%2f..%2fetc/passwd',
      '/%2e%2e/%2e%2e/etc/passwd',
      '/a%00b',
      '/%252e%252e/%252e%252e/etc/passwd',
      '/client/clubhack',
    ]) {
      expect(await site.serve(req(p)), p).toBeNull();
    }
    expect(await site.serve(req('/index.html', { method: 'POST' }))).toBeNull();
  });

  it('index(): the SPA shell, never cached', async () => {
    const r = await site.index(nav('/client/clubhack'));
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(r.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate');
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect(await r.text()).toContain('<div id="root">');
  });

  it('refuses a root without index.html', async () => {
    await expect(createStaticSite(tempDir())).rejects.toThrow(/index\.html/);
  });
});
