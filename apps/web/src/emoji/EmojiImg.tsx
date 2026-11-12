import type { ResolvedEmoji } from './EmojiContext';

export function EmojiImg({ e, className }: { e: ResolvedEmoji; className?: string }) {
  return (
    <img className={`emoji ${className ?? ''}`} src={e.src} alt={e.alt} title={e.title} draggable={false} loading="lazy" />
  );
}
