import { describe, expect, it } from 'vitest';
import { SearchParams, parseSearchQuery, toFtsMatch } from '../src';

describe('search', () => {
  it('parses filters and phrases', () => {
    const r = parseSearchQuery('in:#General from:@alice has:file "zebra crossing" before:2026-11-12 after:2026-11-01 x:y');
    expect(r).toEqual({
      ok: true,
      query: {
        terms: ['zebra crossing', 'x:y'],
        inChannel: 'general',
        from: 'alice',
        hasFile: true,
        before: Date.UTC(2026, 10, 12),
        after: Date.UTC(2026, 10, 2),
      },
    });
  });
  it('treats unknown/empty filters as terms and keeps from case', () => {
    const r = parseSearchQuery('has:other in: from:@Alice "unterminated phrase');
    expect(r).toMatchObject({
      ok: true,
      query: { terms: ['has:other', 'in:', 'unterminated phrase'], from: 'Alice', inChannel: null },
    });
  });
  it('rejects bad input', () => {
    expect(parseSearchQuery('   ')).toMatchObject({ ok: false, code: 'empty', message: 'Type something to search.' });
    expect(parseSearchQuery('""')).toMatchObject({ ok: false, code: 'empty' });
    expect(parseSearchQuery('before:2026-02-30')).toMatchObject({ ok: false, code: 'invalid_date', message: 'Dates use YYYY-MM-DD.' });
    expect(parseSearchQuery('after:nope')).toMatchObject({ ok: false, code: 'invalid_date' });
    expect(parseSearchQuery('a'.repeat(257))).toMatchObject({ ok: false, code: 'too_long', message: 'That search is too long.' });
    expect(parseSearchQuery(Array.from({ length: 17 }, (_, i) => 'a' + i).join(' '))).toMatchObject({ ok: false, code: 'too_long' });
    expect(parseSearchQuery('has:file')).toMatchObject({ ok: true, query: { terms: [], hasFile: true } });
  });
  it('toFtsMatch escapes every term into a phrase', () => {
    expect(toFtsMatch(['zebra', 'a"b', 'NEAR(x y)', '***'])).toBe('"zebra" "a""b" "NEAR(x y)"');
    expect(toFtsMatch(['***'])).toBeNull();
    expect(toFtsMatch(['AND', 'col:x', '^a', 'a*', '"'])).toBe('"AND" "col:x" "^a" "a*"');
  });
  it('SearchParams accepts q up to 1024 (parseSearchQuery owns the 256 rule)', () => {
    expect(SearchParams.safeParse({ q: 'a'.repeat(300) }).success).toBe(true);
    expect(SearchParams.safeParse({ q: 'a'.repeat(1025) }).success).toBe(false);
  });
});
