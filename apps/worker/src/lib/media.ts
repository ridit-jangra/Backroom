/** Headers every served user-uploaded media response carries (emoji, files, thumbnails). */
export const MEDIA_SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'Cache-Control': 'private, max-age=31536000, immutable',
} as const;

/**
 * P6-R8: D1 says the blob exists but the store has none (yet). Workers KV propagates across locations in up to
 * ~60 s, so a fresh upload can miss elsewhere. Only callers that already passed the visibility check use this, so
 * unknown or hidden ids keep their identical 404. Never cached; clients retry with backoff.
 */
export function blobPendingResponse(): Response {
  return new Response(
    JSON.stringify({ error: { code: 'blob_pending', message: 'This file is still syncing. Try again in a few seconds.' } }),
    { status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '5', 'Cache-Control': 'no-store' } },
  );
}
