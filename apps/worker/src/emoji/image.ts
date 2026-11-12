export type SniffedImage = { mime: 'image/png' | 'image/gif' | 'image/jpeg'; width: number; height: number };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR = [0x49, 0x48, 0x44, 0x52];

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);
const be16 = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const be32 = (b: Uint8Array, i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
const le16 = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);

/** SOF0-3, 5-7, 9-11, 13-15: the frame headers that carry the image size. */
function isSof(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function sniffJpeg(b: Uint8Array): SniffedImage | null {
  let i = 2;
  // Each iteration advances i by at least 1, so the walk is linear in the buffer length.
  while (i + 1 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    if (marker === 0xda || marker === 0xd9) return null; // start of scan / end of image: no SOF
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2; // standalone markers carry no length
      continue;
    }
    if (i + 3 >= b.length) return null;
    const length = be16(b, i + 2);
    if (length < 2) return null;
    if (isSof(marker)) {
      if (i + 8 >= b.length) return null;
      return { mime: 'image/jpeg', height: be16(b, i + 5), width: be16(b, i + 7) };
    }
    i += 2 + length;
  }
  return null;
}

/**
 * Image type and dimensions from magic bytes and headers only (never decodes pixel data).
 * Anything other than PNG, GIF or JPEG, or a truncated header, is null.
 */
export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  if (bytes.length >= 24 && startsWith(bytes, PNG_SIGNATURE)) {
    if (!startsWith(bytes, IHDR, 12)) return null;
    return { mime: 'image/png', width: be32(bytes, 16), height: be32(bytes, 20) };
  }
  if (bytes.length >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 &&
      (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return { mime: 'image/gif', width: le16(bytes, 6), height: le16(bytes, 8) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return sniffJpeg(bytes);
  return null;
}
