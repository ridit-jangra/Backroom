import { REACTION_CODE_RE } from '@backroom/protocol';
import { DATA } from './generated/data';
import type { EmojiRecord, ShortcodeMatch, SkinTone } from './types';

let index: Map<string, EmojiRecord> | undefined;

export function lookupEmoji(name: string): EmojiRecord | undefined {
  if (!index) {
    index = new Map();
    for (const r of DATA) for (const n of r.names) if (!index.has(n)) index.set(n, r);
  }
  return index.get(name);
}

export function resolveBuiltin(
  name: string,
  tone: SkinTone | null,
): { record: EmojiRecord; char: string; img: string; canonical: string } | undefined {
  const record = lookupEmoji(name);
  if (!record) return undefined;
  const primary = record.names[0]!;
  if (tone === null || tone === 1) return { record, char: record.char, img: record.img, canonical: primary };
  const skin = record.skins?.[tone - 2];
  if (!skin) return undefined;
  return { record, char: skin.char, img: skin.img, canonical: `${primary}::skin-tone-${tone}` };
}

const TONE_MARK = '::skin-tone-';

export function parseReactionCode(code: string): { name: string; tone: SkinTone | null } | null {
  if (!REACTION_CODE_RE.test(code)) return null;
  const at = code.indexOf(TONE_MARK);
  if (at < 0) return { name: code, tone: null };
  return { name: code.slice(0, at), tone: Number(code.slice(at + TONE_MARK.length)) as SkinTone };
}

export function formatShortcode(name: string, tone: SkinTone | null): string {
  return tone === null || tone === 1 ? name : `${name}${TONE_MARK}${tone}`;
}

/** Test-only work counter: name-scan steps and isKnown calls. */
export const scanWork = { steps: 0, known: 0 };

const MAX_NAME = 64;
const TONE_SUFFIX = /^:skin-tone-([2-6]):/;

function isNameChar(c: number): boolean {
  // a-z 0-9 _ + -
  return (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}

export function findShortcodes(
  text: string,
  isKnown: (name: string, tone: SkinTone | null) => boolean,
): ShortcodeMatch[] {
  const out: ShortcodeMatch[] = [];
  const known = (name: string, tone: SkinTone | null) => {
    scanWork.known++;
    return isKnown(name, tone);
  };
  const n = text.length;
  let i = 0;
  while (i < n) {
    if (text.charCodeAt(i) !== 58) {
      i++;
      continue;
    }
    let j = i + 1;
    scanWork.steps++;
    while (j < n && j - i - 1 < MAX_NAME && isNameChar(text.charCodeAt(j))) {
      j++;
      scanWork.steps++;
    }
    if (j === i + 1 || j >= n || text.charCodeAt(j) !== 58) {
      // The candidate failed at j (j > i): resume there. A ':' at j may open the next one,
      // and the name characters already passed are never rescanned.
      i = j;
      continue;
    }
    const name = text.slice(i + 1, j);
    const tm = TONE_SUFFIX.exec(text.slice(j + 1, j + 14));
    if (tm) {
      const tone = Number(tm[1]) as SkinTone;
      if (known(name, tone)) {
        out.push({ index: i, length: j + 14 - i, name, tone });
        i = j + 14;
        continue;
      }
    }
    if (known(name, null)) {
      out.push({ index: i, length: j + 1 - i, name, tone: null });
      i = j + 1; // resume at the tone's opening colon
    } else {
      i = j; // resume at the closing colon
    }
  }
  return out;
}
