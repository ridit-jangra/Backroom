import { describe, expect, it } from 'vitest';
import { isInlineMime, sanitizeFileName } from '../src';

describe('files', () => {
  it('sanitizeFileName strips controls and separators, keeps unicode', () => {
    expect(sanitizeFileName('a/b\\c\r\n.txt')).toBe('a_b_c.txt');
    expect(sanitizeFileName('  ')).toBe('file');
    expect(sanitizeFileName('\uD800x')).toBe('\uFFFDx');
    expect(sanitizeFileName('x\uDC00')).toBe('x\uFFFD');
    expect(sanitizeFileName('😀.png')).toBe('😀.png');
    expect(Array.from(sanitizeFileName('é'.repeat(300))).length).toBe(255);
    expect(Array.from(sanitizeFileName('😀'.repeat(300))).length).toBe(255);
  });
  it('strips bidi and invisible format controls', () => {
    expect(sanitizeFileName('invoice\u202Efdp.exe')).toBe('invoicefdp.exe');
    expect(sanitizeFileName('a\u200Bb\uFEFFc\u2066d')).toBe('abcd');
  });
  it('strips all Cf format characters', () => {
    expect(sanitizeFileName('a\u061Cb\u00ADc\u{E0041}d')).toBe('abcd');
  });
  it('isInlineMime', () => {
    for (const m of ['image/webp', 'application/pdf', 'video/mp4']) expect(isInlineMime(m)).toBe(true);
    for (const m of ['image/svg+xml', 'text/html', 'application/octet-stream']) expect(isInlineMime(m)).toBe(false);
  });
});
