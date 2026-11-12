import { isInlineMime } from '@backroom/protocol';
import { MEDIA_SECURITY_HEADERS } from '../lib/media';

// Lone surrogates would make encodeURIComponent throw.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** RFC 6266 value: an ASCII-only quoted fallback plus an RFC 5987 UTF-8 extended value. Cannot break out of the header. */
export function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const wellFormed = name.replace(LONE_SURROGATE, '\uFFFD');
  let fallback = '';
  for (const ch of wellFormed) {
    fallback += ch >= ' ' && ch <= '~' && ch !== '"' && ch !== '\\' ? ch : '_';
  }
  const ext = encodeURIComponent(wellFormed).replace(
    /['()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'),
  );
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${ext}`;
}

/** Shared serving headers: inline with the stored type only for the whitelist, everything else an inert attachment. */
export function fileHeaders(f: { mime: string; name: string }, etag: string): Headers {
  const inline = isInlineMime(f.mime);
  const h = new Headers(MEDIA_SECURITY_HEADERS);
  h.set('ETag', etag);
  h.set('Accept-Ranges', 'bytes');
  h.set('Content-Type', inline ? f.mime : 'application/octet-stream');
  h.set('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', f.name));
  return h;
}

const RANGE_RE = /^bytes=(\d{1,15})?-(\d{1,15})?$/;

/** Single byte range only. null = ignore the header (serve 200); 'unsatisfiable' = 416. */
export function parseRange(header: string | null, size: number): { offset: number; length: number } | 'unsatisfiable' | null {
  if (header === null) return null;
  const m = RANGE_RE.exec(header);
  if (!m) return null;
  const [, a, b] = m;
  if (a === undefined && b === undefined) return null;
  if (a === undefined) {
    const n = Number(b);
    if (n === 0 || size === 0) return 'unsatisfiable';
    const length = Math.min(n, size);
    return { offset: size - length, length };
  }
  const start = Number(a);
  if (b !== undefined && start > Number(b)) return null;
  if (start >= size) return 'unsatisfiable';
  const end = b === undefined ? size - 1 : Math.min(Number(b), size - 1);
  return { offset: start, length: end - start + 1 };
}
