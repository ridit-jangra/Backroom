import { describe, expect, it } from 'vitest';
import { sniffFile, sniffWebp, SNIFF_BYTES } from '../src/files/sniff';
import { jpeg, png, webp } from './helpers';

const enc = (s: string) => new TextEncoder().encode(s);
const none = { width: null, height: null };

describe('sniffFile', () => {
  it('sniffs raster, webp and pdf with dimensions', () => {
    expect(sniffFile(png(800, 600), null)).toEqual({ mime: 'image/png', width: 800, height: 600 });
    expect(sniffFile(webp(1000, 500), 'image/png')).toEqual({ mime: 'image/webp', width: 1000, height: 500 });
    expect(sniffFile(enc('%PDF-1.7\n'), null)).toEqual({ mime: 'application/pdf', ...none });
    expect(SNIFF_BYTES).toBe(131_072);
  });

  it('declared types are trusted only for audio/video', () => {
    const html = enc('<html>');
    expect(sniffFile(html, 'image/png').mime).toBe('application/octet-stream');
    expect(sniffFile(html, 'video/MP4; codecs=x').mime).toBe('video/mp4');
    expect(sniffFile(html, 'text/plain').mime).toBe('text/plain');
    expect(sniffFile(html, 'image/svg+xml').mime).toBe('application/octet-stream');
    expect(sniffFile(html, 'application/pdf').mime).toBe('application/octet-stream');
    expect(sniffFile(html, 'bad type!').mime).toBe('application/octet-stream');
    expect(sniffFile(html, null).mime).toBe('application/octet-stream');
    expect(sniffFile(html, 'a/' + 'b'.repeat(100)).mime).toBe('application/octet-stream');
  });

  it('normalizes the declared type in every branch (P4-R4b)', () => {
    const x = enc('hello');
    expect(sniffFile(x, ' Text/Plain; charset=utf-8 ').mime).toBe('text/plain');
    expect(sniffFile(x, 'IMAGE/PNG; x=y').mime).toBe('application/octet-stream');
    expect(sniffFile(x, 'Audio/MPEG').mime).toBe('audio/mpeg');
  });

  it('a JPEG whose SOF lies beyond the window stays a JPEG (P4-R4a)', () => {
    const head = new Uint8Array(SNIFF_BYTES);
    head.set([0xff, 0xd8, 0xff, 0xe1, 0x22, 0x60]); // APP1 of ~140 KB
    expect(sniffFile(head, 'application/octet-stream')).toEqual({ mime: 'image/jpeg', ...none });
    expect(sniffFile(jpeg(30, 20), null)).toEqual({ mime: 'image/jpeg', width: 30, height: 20 });
  });

  it('VP8 and VP8L headers', () => {
    const riff = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];
    const vp8 = new Uint8Array(30);
    vp8.set([...riff, 0x56, 0x50, 0x38, 0x20]);
    vp8.set([0x2c, 0x01], 26); // 300
    vp8.set([0xc8, 0x40], 28); // 200 with scale bits set
    expect(sniffWebp(vp8)).toEqual({ width: 300, height: 200 });

    // VP8L: width 301 -> 300, height 201 -> 200 packed in 14-bit fields.
    const vp8l = new Uint8Array(30);
    vp8l.set([...riff, 0x56, 0x50, 0x38, 0x4c]);
    const w = 300, h = 200;
    vp8l[21] = w & 0xff;
    vp8l[22] = ((w >> 8) & 0x3f) | ((h & 0x3) << 6);
    vp8l[23] = (h >> 2) & 0xff;
    vp8l[24] = (h >> 10) & 0x0f;
    expect(sniffWebp(vp8l)).toEqual({ width: 301, height: 201 });

    expect(sniffWebp(vp8.subarray(0, 20))).toBeNull();
    expect(sniffWebp(vp8.subarray(0, 29))).toBeNull();
    expect(sniffWebp(new Uint8Array(40))).toBeNull();
  });
});
