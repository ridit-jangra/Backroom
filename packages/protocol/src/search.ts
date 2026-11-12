import { z } from 'zod';
import { ChannelKindSchema, MessageSchema } from './messaging';

export const SEARCH_PAGE_SIZE = 20;
export const SEARCH_QUERY_MAX = 256;
export const SEARCH_MAX_TERMS = 16;
export const SEARCH_MAX_OFFSET = 480;

export type ParsedSearch = {
  terms: string[];
  inChannel: string | null;
  from: string | null;
  hasFile: boolean;
  before: number | null;
  after: number | null;
};

export type ParseSearchResult =
  | { ok: true; query: ParsedSearch }
  | { ok: false; code: 'empty' | 'too_long' | 'invalid_date'; message: string };

const DAY_MS = 86_400_000;

function parseDate(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return t;
}

function tokenize(q: string): { text: string; phrase: boolean }[] {
  const out: { text: string; phrase: boolean }[] = [];
  let i = 0;
  while (i < q.length) {
    if (/\s/.test(q[i]!)) {
      i++;
    } else if (q[i] === '"') {
      const end = q.indexOf('"', i + 1);
      const stop = end === -1 ? q.length : end;
      out.push({ text: q.slice(i + 1, stop), phrase: true });
      i = stop + 1;
    } else {
      let j = i;
      while (j < q.length && !/\s/.test(q[j]!)) j++;
      out.push({ text: q.slice(i, j), phrase: false });
      i = j;
    }
  }
  return out;
}

const fail = (code: 'empty' | 'too_long' | 'invalid_date', message: string): ParseSearchResult => ({
  ok: false,
  code,
  message,
});

export function parseSearchQuery(q: string): ParseSearchResult {
  if (q.trim() === '') return fail('empty', 'Type something to search.');
  if (q.length > SEARCH_QUERY_MAX) return fail('too_long', 'That search is too long.');
  const query: ParsedSearch = { terms: [], inChannel: null, from: null, hasFile: false, before: null, after: null };
  for (const tok of tokenize(q)) {
    if (tok.phrase) {
      const t = tok.text.trim();
      if (t) query.terms.push(t);
      continue;
    }
    const m = /^(in|from|has|before|after):(.*)$/i.exec(tok.text);
    const key = m?.[1]!.toLowerCase();
    const val = m?.[2] ?? '';
    if (key === 'in' && val.replace(/^#/, '') !== '') query.inChannel = val.replace(/^#/, '').toLowerCase();
    else if (key === 'from' && val.replace(/^@/, '') !== '') query.from = val.replace(/^@/, '');
    else if (key === 'has' && val.toLowerCase() === 'file') query.hasFile = true;
    else if ((key === 'before' || key === 'after') && val !== '') {
      const t = parseDate(val);
      if (t === null) return fail('invalid_date', 'Dates use YYYY-MM-DD.');
      if (key === 'before') query.before = t;
      else query.after = t + DAY_MS;
    } else query.terms.push(tok.text);
  }
  if (query.terms.length > SEARCH_MAX_TERMS) return fail('too_long', 'That search is too long.');
  const hasFilter =
    query.inChannel !== null ||
    query.from !== null ||
    query.hasFile ||
    query.before !== null ||
    query.after !== null;
  if (query.terms.length === 0 && !hasFilter) return fail('empty', 'Type something to search.');
  return { ok: true, query };
}

/** Every term becomes a quoted FTS5 phrase, so operators (NEAR, AND, *, ^, :, parens) are inert. */
export function toFtsMatch(terms: string[]): string | null {
  const parts = terms
    .filter((t) => /[\p{L}\p{N}]/u.test(t))
    .map((t) => `"${t.replaceAll('"', '""')}"`);
  return parts.length > 0 ? parts.join(' ') : null;
}

export const SnippetSegmentSchema = z.object({ text: z.string(), hit: z.boolean() });
export type SnippetSegment = z.infer<typeof SnippetSegmentSchema>;

export const SearchHitSchema = z.object({
  message: MessageSchema,
  channel: z.object({
    id: z.string(),
    name: z.string().nullable(),
    kind: ChannelKindSchema,
    isMember: z.boolean(),
  }),
  snippet: z.array(SnippetSegmentSchema),
});
export type SearchHit = z.infer<typeof SearchHitSchema>;
export type SearchPage = { results: SearchHit[]; nextCursor: string | null };

// Transport guard only; parseSearchQuery owns the 256-char / 16-term rule (P4-R16).
export const SearchParams = z.object({ q: z.string().max(1024), cursor: z.string().max(200).optional() });
