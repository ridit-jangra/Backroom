/** Headers every served user-uploaded media response carries (emoji, files, thumbnails). */
export const MEDIA_SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'Cache-Control': 'private, max-age=31536000, immutable',
} as const;
