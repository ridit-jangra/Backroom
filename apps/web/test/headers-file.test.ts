import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** Parses Cloudflare's `_headers` format: an unindented URL pattern, then indented `Name: value` lines. */
function parse(text: string): Map<string, Record<string, string>> {
  const rules = new Map<string, Record<string, string>>();
  let current: Record<string, string> | null = null;
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      current = {};
      rules.set(line.trim(), current);
    } else {
      const i = line.indexOf(':');
      current![line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  return rules;
}

describe('public/_headers', () => {
  const rules = parse(readFileSync(`${import.meta.dirname}/../public/_headers`, 'utf8'));

  it('every static response (the SPA document included) carries the security headers (P6-R11)', () => {
    expect(rules.get('/*')).toEqual({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
    });
  });

  it('keeps the Twemoji cache rule', () => {
    expect(rules.get('/twemoji/*')).toEqual({ 'Cache-Control': 'public, max-age=604800' });
  });
});
