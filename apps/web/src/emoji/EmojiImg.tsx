import { useState } from 'react';
import type { ResolvedEmoji } from './EmojiContext';

export function EmojiImg({ e, className }: { e: ResolvedEmoji; className?: string }) {
  // An image that fails to load (a Twemoji SVG we do not ship, a custom emoji deleted since) falls back to its alt text.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  // P3-R17: only our own image routes are ever used as a src.
  if (!e.src.startsWith('/twemoji/') && !e.src.startsWith('/emoji/')) return <>{e.alt}</>;
  if (failedSrc === e.src) return <>{e.alt}</>;
  return (
    <img
      className={`emoji ${className ?? ''}`}
      src={e.src}
      alt={e.alt}
      title={e.title}
      draggable={false}
      loading="lazy"
      onError={() => setFailedSrc(e.src)}
    />
  );
}
