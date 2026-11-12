import { describe, expect, it } from 'vitest';
import { EmojiName, ReactionCode, canAddCustomEmoji } from '../src';

describe('EmojiName', () => {
  it('accepts party_parrot and 32 chars; rejects Party, 33 chars, "a b", "+1"', () => {
    expect(EmojiName.safeParse('party_parrot').success).toBe(true);
    expect(EmojiName.safeParse('a'.repeat(32)).success).toBe(true);
    for (const bad of ['Party', 'a'.repeat(33), 'a b', '+1']) expect(EmojiName.safeParse(bad).success).toBe(false);
  });
});
describe('ReactionCode', () => {
  it('accepts +1, wave::skin-tone-6; rejects ":+1:", "wave::skin-tone-1", "<img>"', () => {
    expect(ReactionCode.safeParse('+1').success).toBe(true);
    expect(ReactionCode.safeParse('wave::skin-tone-6').success).toBe(true);
    for (const bad of [':+1:', 'wave::skin-tone-1', '<img>']) expect(ReactionCode.safeParse(bad).success).toBe(false);
  });
});
describe('canAddCustomEmoji', () => {
  it('member only under everyone; admin and owner always', () => {
    expect(canAddCustomEmoji('member', undefined)).toBe(false);
    expect(canAddCustomEmoji('member', { customEmojiPolicy: 'admins' })).toBe(false);
    expect(canAddCustomEmoji('member', { customEmojiPolicy: 'everyone' })).toBe(true);
    for (const r of ['admin', 'owner'] as const) {
      expect(canAddCustomEmoji(r, undefined)).toBe(true);
      expect(canAddCustomEmoji(r, { customEmojiPolicy: 'admins' })).toBe(true);
    }
  });
});
