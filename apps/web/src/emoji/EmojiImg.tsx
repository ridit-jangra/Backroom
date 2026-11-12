import type { ResolvedEmoji } from './EmojiContext';

export function EmojiImg({ e, className }: { e: ResolvedEmoji; className?: string }) {
  // P3-R17: only our own image routes are ever used as a src.
  if (!e.src.startsWith('/twemoji/') && !e.src.startsWith('/emoji/')) return <>{e.alt}</>;
  return (
    <img className={`emoji ${className ?? ''}`} src={e.src} alt={e.alt} title={e.title} draggable={false} loading="lazy" />
  );
}
