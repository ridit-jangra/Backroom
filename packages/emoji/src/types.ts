export type EmojiCategory =
  | 'Smileys & Emotion'
  | 'People & Body'
  | 'Animals & Nature'
  | 'Food & Drink'
  | 'Travel & Places'
  | 'Activities'
  | 'Objects'
  | 'Symbols'
  | 'Flags'
  | 'Component';

export type SkinTone = 1 | 2 | 3 | 4 | 5 | 6;

export type EmojiRecord = {
  /** Short names, primary first. */
  names: string[];
  char: string;
  /** Twemoji file base name (no extension). */
  img: string;
  category: EmojiCategory;
  order: number;
  /** Lower-cased Unicode name. */
  keywords: string;
  /** Exactly 5 entries: tones 2..6. */
  skins?: { char: string; img: string }[];
  /** Component or obsoleted. */
  hidden?: true;
};

export type EmojiMatch = { name: string; record: EmojiRecord };
export type ShortcodeMatch = { index: number; length: number; name: string; tone: SkinTone | null };
