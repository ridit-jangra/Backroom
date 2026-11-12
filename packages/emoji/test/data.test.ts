import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DATA } from '../src/generated/data';
import { PICKER_CATEGORIES, lookupEmoji, resolveBuiltin, searchEmoji } from '../src';

const gen = (f: string) => fileURLToPath(new URL(`../src/generated/${f}`, import.meta.url));
const imagesTxt = gen('images.txt');
const dataTs = gen('data.ts');

describe('emoji data', () => {
  it('aliases resolve to one record with a canonical primary name', () => {
    expect(lookupEmoji('thumbsup')).toBe(lookupEmoji('+1'));
    expect(resolveBuiltin('thumbsup', null)!.canonical).toBe('+1');
  });
  it('skin tones, uniform multi-person tones and odd filenames', () => {
    expect(resolveBuiltin('wave', 3)).toMatchObject({ char: '\u{1F44B}\u{1F3FC}', img: '1f44b-1f3fc', canonical: 'wave::skin-tone-3' });
    expect(resolveBuiltin('heart', 3)).toBeUndefined();
    expect(resolveBuiltin('heart', null)).toMatchObject({ char: '❤️', img: '2764' });
    expect(resolveBuiltin('man-heart-man', 4)!.img).toBe('1f468-1f3fd-200d-2764-fe0f-200d-1f468-1f3fd');
    expect(resolveBuiltin('hash', null)!.img).toBe('23-20e3');
    expect(resolveBuiltin('eye-in-speech-bubble', null)!.img).toBe('1f441-200d-1f5e8');
  });
  it('table shape and budget', () => {
    expect(DATA).toHaveLength(1_911);
    const listed = readFileSync(imagesTxt, 'utf8').trim().split('\n');
    expect(listed).toEqual([...listed].sort());
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed).toHaveLength(3_526);
    const used = new Set(DATA.flatMap((e) => [e.img, ...(e.skins ?? []).map((s) => s.img)]));
    expect(new Set(listed)).toEqual(used);
    expect(statSync(dataTs).size).toBeLessThanOrEqual(400_000);
    expect(PICKER_CATEGORIES).toHaveLength(9);
    expect(DATA.filter((e) => e.hidden)).toHaveLength(41);
  });
  it('search ranks prefix matches first and reports the matched alias', () => {
    expect(searchEmoji('thu', 3).map((m) => m.name)).toEqual(['thumbsup', 'thumbsdown', 'thunder_cloud_and_rain']);
    expect(searchEmoji(':wave', 1)[0]!.name).toBe('wave');
  });
});
