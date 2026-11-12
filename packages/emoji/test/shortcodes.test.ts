import { describe, expect, it } from 'vitest';
import { findShortcodes, formatShortcode, parseReactionCode, resolveBuiltin, type SkinTone } from '../src';

const known = (n: string, t: SkinTone | null) => resolveBuiltin(n, t) !== undefined;
const timed = (text: string) => {
  const t0 = performance.now();
  findShortcodes(text, known);
  return performance.now() - t0;
};

describe('findShortcodes', () => {
  it('resumes at the closing colon and is linear', () => {
    expect(findShortcodes(':foo:smile:', known)).toEqual([{ index: 4, length: 7, name: 'smile', tone: null }]);
    expect(findShortcodes('10:30:45', known)).toEqual([]);
    expect(findShortcodes('::::', known)).toEqual([]);
    expect(findShortcodes(':wave::skin-tone-3:', known)).toEqual([{ index: 0, length: 19, name: 'wave', tone: 3 }]);
    expect(findShortcodes(':heart::skin-tone-3:', known)).toEqual([
      { index: 0, length: 7, name: 'heart', tone: null },
      { index: 7, length: 13, name: 'skin-tone-3', tone: null },
    ]);
    expect(findShortcodes('hi :wave: and :+1:', known).map((m) => m.name)).toEqual(['wave', '+1']);
    expect(timed(':a'.repeat(50_000))).toBeLessThan(50);
    expect(timed(':'.repeat(100_000))).toBeLessThan(50);
  });
  it('worst cases for a failing candidate stay linear', () => {
    expect(timed(':' + 'a'.repeat(100_000))).toBeLessThan(50);
    expect(timed((':' + 'a'.repeat(64) + 'b').repeat(1_500))).toBeLessThan(50);
    expect(timed(':zq'.repeat(33_000))).toBeLessThan(50);
  });
  it('a failing candidate resumes at the failing character', () => {
    expect(findShortcodes(':ab c:smile:', known)).toEqual([{ index: 5, length: 7, name: 'smile', tone: null }]);
    expect(findShortcodes(':' + 'a'.repeat(65) + ':smile:', known).map((m) => m.name)).toEqual(['smile']);
    expect(findShortcodes(':<b>x</b>:', known)).toEqual([]);
  });
});

describe('reaction codes', () => {
  it('parseReactionCode and formatShortcode round-trip; reject ":wave:", "Wave", "wave::skin-tone-7", 65-char names', () => {
    expect(parseReactionCode('wave::skin-tone-3')).toEqual({ name: 'wave', tone: 3 });
    expect(parseReactionCode('+1')).toEqual({ name: '+1', tone: null });
    expect(formatShortcode('wave', 3)).toBe('wave::skin-tone-3');
    expect(formatShortcode('wave', null)).toBe('wave');
    expect(formatShortcode('wave', 1)).toBe('wave');
    expect(parseReactionCode(formatShortcode('wave', 5))).toEqual({ name: 'wave', tone: 5 });
    for (const bad of [':wave:', 'Wave', 'wave::skin-tone-7', 'wave::skin-tone-1', 'a'.repeat(65), '']) {
      expect(parseReactionCode(bad)).toBeNull();
    }
    expect(parseReactionCode('a'.repeat(64))).not.toBeNull();
  });
});
