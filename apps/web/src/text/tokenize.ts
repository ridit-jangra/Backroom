import { BROADCAST_RE, USER_MENTION_RE, type MemberSummary } from '@backroom/protocol';

export type Token =
  | { kind: 'text'; text: string }
  | { kind: 'link'; href: string; text: string }
  | { kind: 'user'; userId: string }
  | { kind: 'broadcast'; which: 'channel' | 'here' };

const LINK_RE = /https?:\/\/[^\s<>"]+/g;
const TRAILING_PUNCT = '.,!?:;\'"';

function count(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

/** Trim trailing punctuation and an unbalanced ")" back to plain text. */
function trimLink(raw: string): string {
  let s = raw;
  for (;;) {
    const last = s[s.length - 1];
    if (last !== undefined && TRAILING_PUNCT.includes(last)) {
      s = s.slice(0, -1);
    } else if (last === ')' && count(s, ')') > count(s, '(')) {
      s = s.slice(0, -1);
    } else return s;
  }
}

function isHttp(text: string): boolean {
  try {
    const p = new URL(text).protocol;
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
  }
}

type Span = { start: number; end: number; token: Token };

export function tokenize(body: string): Token[] {
  const spans: Span[] = [];
  for (const m of body.matchAll(LINK_RE)) {
    const text = trimLink(m[0]);
    if (text.length > 0 && isHttp(text)) {
      spans.push({ start: m.index, end: m.index + text.length, token: { kind: 'link', href: text, text } });
    }
  }
  for (const m of body.matchAll(new RegExp(USER_MENTION_RE.source, 'g'))) {
    spans.push({ start: m.index, end: m.index + m[0].length, token: { kind: 'user', userId: m[1]! } });
  }
  for (const m of body.matchAll(new RegExp(BROADCAST_RE.source, 'g'))) {
    spans.push({
      start: m.index,
      end: m.index + m[0].length,
      token: { kind: 'broadcast', which: m[1] as 'channel' | 'here' },
    });
  }
  spans.sort((a, b) => a.start - b.start || b.end - a.end);

  const out: Token[] = [];
  let pos = 0;
  for (const s of spans) {
    if (s.start < pos) continue; // overlaps an earlier token
    if (s.start > pos) out.push({ kind: 'text', text: body.slice(pos, s.start) });
    out.push(s.token);
    pos = s.end;
  }
  if (pos < body.length) out.push({ kind: 'text', text: body.slice(pos) });
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replace `@DisplayName` (longest names first) with `<@userId>`. */
export function encodeMentions(text: string, picked: Map<string, string>): string {
  if (picked.size === 0) return text;
  const names = [...picked.keys()].sort((a, b) => b.length - a.length).map(escapeRe);
  const re = new RegExp(`@(${names.join('|')})(?=$|[\\s.,!?:;)\\]'"])`, 'g');
  return text.replace(re, (_m, name: string) => `<@${picked.get(name)!}>`);
}

/** Inverse of encodeMentions, for editing. Unknown IDs stay as tokens. */
export function decodeMentions(
  body: string,
  members: MemberSummary[],
): { text: string; picked: Map<string, string> } {
  const byId = new Map(members.map((m) => [m.id, m.displayName]));
  const picked = new Map<string, string>();
  const text = body.replace(new RegExp(USER_MENTION_RE.source, 'g'), (m, id: string) => {
    const name = byId.get(id);
    if (name === undefined) return m;
    picked.set(name, id);
    return `@${name}`;
  });
  return { text, picked };
}
