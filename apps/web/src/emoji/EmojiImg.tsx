import { useImageRetry } from '../components/useImageRetry';
import type { ResolvedEmoji } from './EmojiContext';

export function EmojiImg({ e, className }: { e: ResolvedEmoji; className?: string }) {
  // An image that fails to load falls back to its alt text. A Twemoji SVG we do not ship fails at once; a custom
  // emoji may still be syncing to this location (P6-R8), so it retries with backoff before giving up.
  const custom = e.src.startsWith('/emoji/');
  const { attempt, waiting, failed, onError } = useImageRetry(e.src, custom);
  // P3-R17: only our own image routes are ever used as a src.
  if (!e.src.startsWith('/twemoji/') && !custom) return <>{e.alt}</>;
  if (waiting || failed) return <>{e.alt}</>;
  return (
    <img
      key={attempt}
      className={`emoji ${className ?? ''}`}
      src={e.src}
      alt={e.alt}
      title={e.title}
      draggable={false}
      loading="lazy"
      onError={onError}
    />
  );
}
