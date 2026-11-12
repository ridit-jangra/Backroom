import type { CustomEmoji } from '@backroom/protocol';
import { searchEmoji, type EmojiRecord } from '@backroom/emoji';

export type EmojiSuggestion = { kind: 'custom'; name: string } | { kind: 'builtin'; name: string; record: EmojiRecord };

/** P3-R10: custom names starting with the query (alphabetical), then built-in matches, up to `limit`. */
export function suggestEmoji(query: string, custom: ReadonlyMap<string, CustomEmoji>, limit: number): EmojiSuggestion[] {
  const q = query.toLowerCase().replaceAll(':', '');
  if (!q || limit <= 0) return [];
  const names = [...custom.keys()].filter((n) => n.startsWith(q)).sort().slice(0, limit);
  const out: EmojiSuggestion[] = names.map((name) => ({ kind: 'custom', name }));
  for (const m of searchEmoji(q, limit - out.length)) out.push({ kind: 'builtin', name: m.name, record: m.record });
  return out;
}
