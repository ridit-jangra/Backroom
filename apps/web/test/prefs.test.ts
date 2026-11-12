import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FREQUENT } from '@backroom/emoji';
import { addUse, loadPrefs, savePrefs, topFrequent, type EmojiPrefs } from '../src/emoji/prefs';

const ME = '01JME'.padEnd(26, '0');
const BOB = '01JBOB'.padEnd(26, '0');

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('emoji prefs', () => {
  it('round-trips per user', () => {
    expect(loadPrefs(ME)).toEqual({ skinTone: 1, uses: {} });
    const p: EmojiPrefs = { skinTone: 4, uses: { wave: { n: 2, at: 10 } } };
    savePrefs(ME, p);
    expect(localStorage.getItem(`backroom:emoji:${ME}`)).not.toBeNull();
    expect(loadPrefs(ME)).toEqual(p);
    expect(loadPrefs(BOB)).toEqual({ skinTone: 1, uses: {} });
    localStorage.setItem(`backroom:emoji:${BOB}`, '{not json');
    expect(loadPrefs(BOB)).toEqual({ skinTone: 1, uses: {} });
    localStorage.setItem(`backroom:emoji:${BOB}`, JSON.stringify({ skinTone: 9, uses: 'x' }));
    expect(loadPrefs(BOB)).toEqual({ skinTone: 1, uses: {} });
  });

  it('topFrequent orders by count then recency and defaults to DEFAULT_FREQUENT', () => {
    const empty: EmojiPrefs = { skinTone: 1, uses: {} };
    expect(topFrequent(empty)).toEqual(DEFAULT_FREQUENT);
    let p = addUse(empty, 'wave', 1);
    p = addUse(p, 'tada', 2);
    p = addUse(p, 'fire', 3);
    p = addUse(p, 'wave', 4);
    expect(p.uses.wave).toEqual({ n: 2, at: 4 });
    expect(topFrequent(p)).toEqual(['wave', 'fire', 'tada']);
    expect(topFrequent(p, 2)).toEqual(['wave', 'fire']);
    expect(empty.uses).toEqual({}); // pure
  });

  it('addUse keeps at most 50', () => {
    let p: EmojiPrefs = { skinTone: 1, uses: {} };
    for (let i = 0; i < 60; i++) p = addUse(p, `e${i}`, i);
    expect(Object.keys(p.uses)).toHaveLength(50);
    expect(p.uses.e0).toBeUndefined();
    expect(p.uses.e9).toBeUndefined();
    expect(p.uses.e10).toBeDefined();
    expect(p.uses.e59).toBeDefined();
  });

  it('works when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(loadPrefs(ME)).toEqual({ skinTone: 1, uses: {} });
    expect(() => savePrefs(ME, { skinTone: 2, uses: {} })).not.toThrow();
  });
});
