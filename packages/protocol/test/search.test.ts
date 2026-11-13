import { describe, expect, it } from 'vitest';
import { SEARCH_MAX_TERMS, SEARCH_QUERY_MAX, SearchParams, parseSearchQuery, toFtsMatch } from '../src';

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
    expect(parseSearchQuery('a'.repeat(201))).toMatchObject({ ok: false, code: 'too_long', message: 'That search is too long.' });
    expect(parseSearchQuery('a'.repeat(200))).toMatchObject({ ok: true });
    expect(parseSearchQuery('has:file')).toMatchObject({ ok: true, query: { terms: [], hasFile: true } });
  });
  it('caps a query at 8 terms (P4-R24): the rest are ignored and listed', () => {
    expect(SEARCH_QUERY_MAX).toBe(200);
    expect(SEARCH_MAX_TERMS).toBe(8);
    const r = parseSearchQuery('in:#x t1 t2 "t 3" t4 has:file t5 t6 t7 t8 t9 "t 10"');
    expect(r).toMatchObject({ ok: true, query: { terms: ['t1', 't2', 't 3', 't4', 't5', 't6', 't7', 't8'], ignoredTerms: ['t9', 't 10'], hasFile: true, inChannel: 'x' } });
    const eight = parseSearchQuery('a b c d e f g h');
    expect(eight.ok && eight.query.terms).toHaveLength(8);
    expect(eight.ok && 'ignoredTerms' in eight.query).toBe(false);
    const many = parseSearchQuery(Array.from({ length: 17 }, (_, i) => 'a' + i).join(' '));
    expect(many.ok && many.query.ignoredTerms).toHaveLength(9);
  });
  it('toFtsMatch escapes every term into a phrase', () => {
    expect(toFtsMatch(['zebra', 'a"b', 'NEAR(x y)', '***'])).toBe('"zebra" "a""b" "NEAR(x y)"');
    expect(toFtsMatch(['***'])).toBeNull();
    expect(toFtsMatch(['AND', 'col:x', '^a', 'a*', '"'])).toBe('"AND" "col:x" "^a" "a*"');
  });
  it('SearchParams accepts q up to 1024 (parseSearchQuery owns the 200 rule)', () => {
    expect(SearchParams.safeParse({ q: 'a'.repeat(300) }).success).toBe(true);
    expect(SearchParams.safeParse({ q: 'a'.repeat(1025) }).success).toBe(false);
  });
});
