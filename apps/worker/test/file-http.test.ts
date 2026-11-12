import { describe, expect, it } from 'vitest';
import { contentDisposition, fileHeaders, parseRange } from '../src/files/http';

describe('contentDisposition', () => {
  it('is header-safe and RFC 5987 encoded', () => {
    expect(contentDisposition('attachment', 'résumé "final".svg')).toBe(
      `attachment; filename="r_sum_ _final_.svg"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22final%22.svg`,
    );
    expect(contentDisposition('attachment', 'a(1)*.txt')).toContain(`filename*=UTF-8''a%281%29%2A.txt`);
  });

  it('cannot be broken out of with CR/LF, quotes, backslashes or lone surrogates', () => {
    const v = contentDisposition('inline', 'a\r\nSet-Cookie: x=1"; \\b\uD800.png');
    expect(v).not.toMatch(/[\r\n]/);
    expect(v).toMatch(/^inline; filename="[ -~]*"; filename\*=UTF-8''[A-Za-z0-9%._~!-]*$/);
    const fallback = /filename="([^"]*)"/.exec(v)![1]!;
    expect(fallback).not.toContain('\\');
    expect(v.endsWith('%EF%BF%BD.png')).toBe(true);
    expect(() => new Headers({ 'Content-Disposition': v })).not.toThrow();
    // An astral code point is one fallback character.
    expect(contentDisposition('inline', '\u{1F600}.png')).toContain('filename="_.png"');
  });
});

describe('fileHeaders', () => {
  it('inline only for the whitelist', () => {
    const html = fileHeaders({ mime: 'text/html', name: 'x.html' }, '"e"');
    expect(html.get('Content-Type')).toBe('application/octet-stream');
    expect(html.get('Content-Disposition')).toMatch(/^attachment/);
    const svg = fileHeaders({ mime: 'image/svg+xml', name: 'x.svg' }, '"e"');
    expect(svg.get('Content-Disposition')).toMatch(/^attachment/);
    const img = fileHeaders({ mime: 'image/png', name: 'x.png' }, '"e"');
    expect(img.get('Content-Type')).toBe('image/png');
    expect(img.get('Content-Disposition')).toMatch(/^inline/);
    for (const h of [html, img]) {
      expect(h.get('X-Content-Type-Options')).toBe('nosniff');
      expect(h.get('Content-Security-Policy')).toBe("default-src 'none'; sandbox");
      expect(h.get('Cache-Control')).toBe('private, max-age=31536000, immutable');
      expect(h.get('Accept-Ranges')).toBe('bytes');
      expect(h.get('ETag')).toBe('"e"');
    }
  });
});

describe('parseRange', () => {
  const cases: [string | null, ReturnType<typeof parseRange>][] = [
    ['bytes=0-99', { offset: 0, length: 100 }],
    ['bytes=900-', { offset: 900, length: 100 }],
    ['bytes=-10', { offset: 990, length: 10 }],
    ['bytes=-5000', { offset: 0, length: 1000 }],
    ['bytes=0-5000', { offset: 0, length: 1000 }],
    ['bytes=999-999', { offset: 999, length: 1 }],
    ['bytes=1000-', 'unsatisfiable'],
    ['bytes=1000-2000', 'unsatisfiable'],
    ['bytes=-0', 'unsatisfiable'],
    ['bytes=5-2', null],
    ['bytes=0-1,5-6', null],
    ['items=0-1', null],
    ['bytes=-', null],
    ['bytes=', null],
    ['bytes=a-b', null],
    ['bytes= 0-5', null],
    ['bytes=0-5 ', null],
    ['bytes=+1-5', null],
    ['bytes=1e2-5', null],
    ['bytes=0-999999999999999', { offset: 0, length: 1000 }],
    ['bytes=0-1000000000000000', null],
    ['bytes=1000000000000000000-', null],
    ['bytes=--5', null],
    ['BYTES=0-1', null],
    ['', null],
    [null, null],
  ];
  it.each(cases)('%s', (h, want) => {
    expect(parseRange(h, 1000)).toEqual(want);
  });
  it('size 0 is unsatisfiable', () => {
    expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable');
    expect(parseRange('bytes=-5', 0)).toBe('unsatisfiable');
  });
});
