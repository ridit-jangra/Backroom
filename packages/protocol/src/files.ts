import { z } from 'zod';

export const FILE_MAX_BYTES = 26_214_400;
/** 900 MiB per workspace: Workers KV holds 1 GB in total, and custom emoji share it. */
export const FILES_QUOTA_BYTES = 943_718_400;
export const THUMB_MAX_BYTES = 524_288;
export const THUMB_MAX_SIDE = 720;
export const MAX_FILES_PER_MESSAGE = 10;
export const FILE_NAME_MAX = 255;
export const ORPHAN_TTL_MS = 86_400_000;

export const FileInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  mime: z.string(),
  size: z.number().int().min(0),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  hasThumb: z.boolean(),
});
export type FileInfo = z.infer<typeof FileInfoSchema>;

export const RASTER_MIME: readonly string[] = ['image/png', 'image/gif', 'image/jpeg', 'image/webp'];
export const AV_MIME: readonly string[] = [
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'audio/flac',
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
];

export function isRasterImage(mime: string): boolean {
  return RASTER_MIME.includes(mime);
}
export function isInlineMime(mime: string): boolean {
  return isRasterImage(mime) || mime === 'application/pdf' || AV_MIME.includes(mime);
}

export const fileUrl = (id: string): string => `/files/${id}`;
export const thumbUrl = (id: string): string => `/files/${id}/thumb`;

// Lone surrogates (String.prototype.toWellFormed is ES2024; lib is ES2023).
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
// C0/C1 controls plus every Unicode format (Cf) character: bidi, zero-width, soft hyphen, tags, etc.
const STRIPPED = /[\u0000-\u001F\u007F-\u009F\p{Cf}\u2028\u2029]/gu;

export function sanitizeFileName(raw: string): string {
  const s = raw
    .replace(LONE_SURROGATE, '\uFFFD')
    .replace(STRIPPED, '')
    .replace(/[/\\]/g, '_')
    .trim();
  const cps = Array.from(s);
  const out = cps.length > FILE_NAME_MAX ? cps.slice(0, FILE_NAME_MAX).join('') : s;
  return out.length === 0 ? 'file' : out;
}
