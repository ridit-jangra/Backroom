import { BROADCAST_RE, USER_MENTION_RE, type MemberSummary } from '@backroom/protocol';
import { findShortcodes, resolveBuiltin, type SkinTone } from '@backroom/emoji';

export type Token =
  | { kind: 'text'; text: string }
  | { kind: 'link'; href: string; text: string }
  | { kind: 'user'; userId: string }
  | { kind: 'broadcast'; which: 'channel' | 'here' }
  /** `text` is the original `:name:` / `:name::skin-tone-N:` as written. */
  | { kind: 'emoji'; name: string; tone: SkinTone | null; text: string };

export type IsKnownEmoji = (name: string, tone: SkinTone | null) => boolean;

const builtinKnown: IsKnownEmoji = (n, t) => resolveBuiltin(n, t) !== undefined;

/** At most this many emoji (and nothing but whitespace) render large. */
export const JUMBO_MAX = 23;

const LINK_RE = /https?:\/\/[^\s<>"]+/g;
const TRAILING_PUNCT = '.,!?:;\'"';

/** Trim trailing punctuation and an unbalanced ")" back to plain text. */
function trimLink(raw: string): string {
  let end = raw.length;
  let open = 0;
  let close = 0;
  for (let i = 0; i < end; i++) {
    if (raw[i] === '(') open++;
    else if (raw[i] === ')') close++;
  }
  while (end > 0) {
    const last = raw[end - 1]!;
    if (TRAILING_PUNCT.includes(last)) end--;
    else if (last === ')' && close > open) {
      close--;
      end--;
    } else break;
  }
  return raw.slice(0, end);
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

export function tokenize(body: string, isKnownEmoji: IsKnownEmoji = builtinKnown): Token[] {
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
  // Linear scan; codes that overlap a link or mention are dropped by the overlap rule below.
  for (const m of findShortcodes(body, isKnownEmoji)) {
    const text = body.slice(m.index, m.index + m.length);
    spans.push({ start: m.index, end: m.index + m.length, token: { kind: 'emoji', name: m.name, tone: m.tone, text } });
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

/** 1..JUMBO_MAX emoji tokens and otherwise only whitespace text. */
export function isEmojiOnly(tokens: Token[]): boolean {
  let emoji = 0;
  for (const t of tokens) {
    if (t.kind === 'emoji') {
      if (++emoji > JUMBO_MAX) return false;
    } else if (t.kind !== 'text' || t.text.trim() !== '') return false;
  }
  return emoji > 0;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replace `@DisplayName` (longest names first) with `<@userId>`. */
export function encodeMentions(text: string, picked: Map<string, string>): string {
  if (picked.size === 0) return text;
  const names = [...picked.keys()].sort((a, b) => b.length - a.length).map(escapeRe);
  const re = new RegExp(`(?<![A-Za-z0-9_])@(${names.join('|')})(?=$|[\\s.,!?:;)\\]'"])`, 'g');
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
