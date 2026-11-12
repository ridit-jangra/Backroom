import { REACTION_CODE_RE } from '@backroom/protocol';
import { DEFAULT_FREQUENT, type SkinTone } from '@backroom/emoji';

/** Per-user emoji preferences, kept only in this browser's localStorage. */
export type EmojiPrefs = { skinTone: SkinTone; uses: Record<string, { n: number; at: number }> };

const MAX_USES = 50;
const key = (userId: string) => `backroom:emoji:${userId}`;
const defaults = (): EmojiPrefs => ({ skinTone: 1, uses: {} });

function isTone(v: unknown): v is SkinTone {
  return v === 1 || v === 2 || v === 3 || v === 4 || v === 5 || v === 6;
}

function isUse(v: unknown): v is { n: number; at: number } {
  if (typeof v !== 'object' || v === null) return false;
  const u = v as { n?: unknown; at?: unknown };
  return typeof u.n === 'number' && Number.isFinite(u.n) && u.n > 0 && typeof u.at === 'number' && Number.isFinite(u.at);
}

export function loadPrefs(userId: string): EmojiPrefs {
  let raw: string | null;
  try {
    raw = localStorage.getItem(key(userId));
  } catch {
    return defaults();
  }
  if (raw === null) return defaults();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaults();
  }
  if (typeof parsed !== 'object' || parsed === null) return defaults();
  const p = parsed as { skinTone?: unknown; uses?: unknown };
  if (!isTone(p.skinTone) || typeof p.uses !== 'object' || p.uses === null || Array.isArray(p.uses)) return defaults();
  // fromEntries defines own properties, so a stored "__proto__" key stays inert.
  // P3-R17: only well-formed codes, and only the 50 most recent (a hand-edited store can't bloat state).
  const uses: EmojiPrefs['uses'] = Object.fromEntries(
    Object.entries(p.uses)
      .filter((e): e is [string, { n: number; at: number }] => REACTION_CODE_RE.test(e[0]) && isUse(e[1]))
      .sort(([, a], [, b]) => b.at - a.at)
      .slice(0, MAX_USES)
      .map(([code, u]) => [code, { n: u.n, at: u.at }]),
  );
  return { skinTone: p.skinTone, uses };
}

export function savePrefs(userId: string, p: EmojiPrefs): void {
  try {
    localStorage.setItem(key(userId), JSON.stringify(p));
  } catch {
    // Storage unavailable or full: preferences just don't persist.
  }
}

/** Count one use of `code`; keeps at most 50 entries, evicting the least recently used. */
export function addUse(p: EmojiPrefs, code: string, now: number): EmojiPrefs {
  const prev = Object.hasOwn(p.uses, code) ? p.uses[code] : undefined;
  const uses: EmojiPrefs['uses'] = { ...p.uses, [code]: { n: (prev?.n ?? 0) + 1, at: now } };
  const codes = Object.keys(uses);
  if (codes.length > MAX_USES) {
    codes.sort((a, b) => uses[a]!.at - uses[b]!.at);
    for (const c of codes.slice(0, codes.length - MAX_USES)) delete uses[c];
  }
  return { ...p, uses };
}

/** Most used first, ties broken by most recent; `DEFAULT_FREQUENT` when nothing was used yet. */
export function topFrequent(p: EmojiPrefs, limit = 24): string[] {
  const entries = Object.entries(p.uses);
  if (entries.length === 0) return DEFAULT_FREQUENT.slice(0, limit);
  return entries
    .sort(([, a], [, b]) => b.n - a.n || b.at - a.at)
    .slice(0, limit)
    .map(([code]) => code);
}
