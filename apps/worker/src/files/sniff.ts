import { AV_MIME } from '@backroom/protocol';
import { sniffImage } from '../emoji/image';

export const SNIFF_BYTES = 131_072;

const OCTET = 'application/octet-stream';
const MIME_RE = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/;

const le16 = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const le24 = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const ascii = (b: Uint8Array, at: number, s: string) => s.length > 0 && [...s].every((ch, i) => b[at + i] === ch.charCodeAt(0));

/** WebP dimensions from the RIFF header only (VP8, VP8L, VP8X). Truncated or unknown is null. */
export function sniffWebp(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 16 || !ascii(b, 0, 'RIFF') || !ascii(b, 8, 'WEBP')) return null;
  if (ascii(b, 12, 'VP8 ')) {
    if (b.length < 30) return null;
    return { width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff };
  }
  if (ascii(b, 12, 'VP8L')) {
    if (b.length < 25) return null;
    return {
      width: 1 + (((b[22]! & 0x3f) << 8) | b[21]!),
      height: 1 + (((b[24]! & 0x0f) << 10) | (b[23]! << 2) | ((b[22]! & 0xc0) >> 6)),
    };
  }
  if (ascii(b, 12, 'VP8X')) {
    if (b.length < 30) return null;
    return { width: 1 + le24(b, 24), height: 1 + le24(b, 27) };
  }
  return null;
}

export type SniffedFile = { mime: string; width: number | null; height: number | null };

/**
 * Stored MIME for an upload. Images and PDFs are decided by magic bytes only; the client's
 * type is trusted solely for the audio/video whitelist (served inline with nosniff + sandbox).
 */
export function sniffFile(head: Uint8Array, declared: string | null): SniffedFile {
  const img = sniffImage(head);
  if (img) return img;
  const webp = sniffWebp(head);
  if (webp) return { mime: 'image/webp', ...webp };
  if (ascii(head, 0, '%PDF-')) return { mime: 'application/pdf', width: null, height: null };
  // P4-R4: a JPEG whose SOF lies beyond the sniffed window is still a JPEG, just without a size.
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return { mime: 'image/jpeg', width: null, height: null };
  }

  const type = (declared ?? '').split(';')[0]!.trim().toLowerCase();
  if (AV_MIME.includes(type)) return { mime: type, width: null, height: null };
  if (type.startsWith('image/') || type === 'application/pdf') return { mime: OCTET, width: null, height: null };
  if (type.length <= 100 && MIME_RE.test(type)) return { mime: type, width: null, height: null };
  return { mime: OCTET, width: null, height: null };
}
