import { describe, expect, it } from 'vitest';
import { sniffImage } from '../src/emoji/image';
import { gif, jpeg, png } from './helpers';

const text = (s: string) => new TextEncoder().encode(s);

describe('sniffImage', () => {
  it('png/gif/jpeg dimensions', () => {
    expect(sniffImage(png(40, 33))).toEqual({ mime: 'image/png', width: 40, height: 33 });
    expect(sniffImage(png(70_000, 3_000_000_000))).toEqual({ mime: 'image/png', width: 70_000, height: 3_000_000_000 });
    expect(sniffImage(gif(32, 32))).toEqual({ mime: 'image/gif', width: 32, height: 32 });
    expect(sniffImage(gif(300, 513))).toEqual({ mime: 'image/gif', width: 300, height: 513 });
    const j = jpeg(64, 48);
    expect([j[2], j[3]]).toEqual([0xff, 0xe0]); // APP0 comes before SOF0
    expect(sniffImage(j)).toEqual({ mime: 'image/jpeg', width: 64, height: 48 });
  });

  it('jpeg: skips fill bytes and standalone markers, accepts progressive SOF2', () => {
    const j = jpeg(100, 200);
    // Insert a fill byte and an RST0 marker (no length) before APP0, and make SOF0 a SOF2.
    const sofAt = 2 + 18;
    j[sofAt + 1] = 0xc2;
    const withFill = new Uint8Array([0xff, 0xd8, 0xff, 0xff, 0xd0, ...j.slice(2)]);
    expect(sniffImage(withFill)).toEqual({ mime: 'image/jpeg', width: 100, height: 200 });
  });

  it('rejects svg, html, webp, truncated png, jpeg without SOF', () => {
    expect(sniffImage(text('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImage(text('<html><script>alert(1)</script></html>'))).toBeNull();
    expect(sniffImage(text('RIFF\x24\x00\x00\x00WEBPVP8 '))).toBeNull();
    expect(sniffImage(png(40, 40).slice(0, 23))).toBeNull();
    expect(sniffImage(png(40, 40).slice(0, 8))).toBeNull();
    const notIhdr = png(40, 40);
    notIhdr[12] = 0x58;
    expect(sniffImage(notIhdr)).toBeNull();
    expect(sniffImage(gif(32, 32).slice(0, 9))).toBeNull();
    expect(sniffImage(new Uint8Array(0))).toBeNull();
    // SOI + APP0 + SOS: scanning stops at FFDA, never finding a SOF.
    const app0 = jpeg(64, 48).slice(0, 20);
    expect(sniffImage(new Uint8Array([...app0, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0, 0xff, 0xc0, 0, 17, 8, 0, 48, 0, 64]))).toBeNull();
    // SOI + APP0 only (end of buffer).
    expect(sniffImage(app0)).toBeNull();
    // A segment length that runs past the buffer.
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff, 0]))).toBeNull();
    // A SOF header cut short.
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0]))).toBeNull();
    // Garbage where a marker should be.
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0x00, 0xc0, 0, 17, 8, 0, 48, 0, 64]))).toBeNull();
  });
});
