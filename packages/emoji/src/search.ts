import { DATA } from './generated/data';
import type { EmojiCategory, EmojiMatch, EmojiRecord } from './types';

export const PICKER_CATEGORIES: EmojiCategory[] = [
  'Smileys & Emotion',
  'People & Body',
  'Animals & Nature',
  'Food & Drink',
  'Travel & Places',
  'Activities',
  'Objects',
  'Symbols',
  'Flags',
];

export const DEFAULT_FREQUENT = ['+1', 'heart', 'joy', 'tada', 'eyes', 'pray', 'white_check_mark', 'fire'];

export function twemojiSrc(img: string): string {
  return `/twemoji/${img}.svg`;
}

export function emojiInCategory(c: EmojiCategory): EmojiRecord[] {
  return DATA.filter((r) => r.category === c && !r.hidden).sort((a, b) => a.order - b.order);
}

export function searchEmoji(query: string, limit: number): EmojiMatch[] {
  const q = query.toLowerCase().replaceAll(':', '');
  if (!q || limit <= 0) return [];
  const hits: { rank: number; name: string; record: EmojiRecord }[] = [];
  for (const record of DATA) {
    if (record.hidden) continue;
    let rank = 3;
    let name = record.names[0]!;
    for (const n of record.names) {
      const r = n.startsWith(q) ? 0 : n.includes(`_${q}`) || n.includes(`-${q}`) ? 1 : 3;
      if (r < rank) {
        rank = r;
        name = n;
      }
    }
    if (rank === 3 && record.keywords.includes(q)) rank = 2;
    if (rank < 3) hits.push({ rank, name, record });
  }
  hits.sort((a, b) => a.rank - b.rank || a.record.order - b.record.order);
  return hits.slice(0, limit).map(({ name, record }) => ({ name, record }));
}
