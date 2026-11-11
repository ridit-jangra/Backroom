import { describe, expect, it } from 'vitest';
import { extractMentions, findBroadcasts, HistoryQuery, USER_MENTION_RE } from '../src';

const A = '01HZZZZZZZZZZZZZZZZZZZZZZA';
const B = '01HZZZZZZZZZZZZZZZZZZZZZZB';

describe('extractMentions', () => {
  it('extracts user tokens deduped in order', () => {
    expect(extractMentions(`<@${B}> hi <@${A}> <@${B}>`)).toEqual({ userIds: [B, A], channel: false, here: false });
  });
  it('finds @channel and @here at word boundaries only', () => {
    expect(extractMentions('@channel look')).toMatchObject({ channel: true, here: false });
    expect(extractMentions('ping @here.')).toMatchObject({ here: true });
    expect(extractMentions('mail me@channel.io or @channels')).toMatchObject({ channel: false, here: false });
  });
  it('caps user mentions at 50', () => {
    const ids = Array.from({ length: 60 }, (_, i) => `01H${String(i).padStart(23, '0')}`);
    expect(extractMentions(ids.map((i) => `<@${i}>`).join(' ')).userIds).toHaveLength(50);
  });
  it('exports shared matchers with positions', () => {
    expect(findBroadcasts('a @here and @channel')).toEqual([
      { index: 2, length: 5, kind: 'here' },
      { index: 12, length: 8, kind: 'channel' },
    ]);
    expect(new RegExp(USER_MENTION_RE.source, 'g').test(`<@${A}>`)).toBe(true);
  });
});

describe('HistoryQuery', () => {
  it('defaults limit to 50, rejects before+after and limit>100', () => {
    expect(HistoryQuery.parse({}).limit).toBe(50);
    expect(HistoryQuery.safeParse({ before: '5', after: '2' }).success).toBe(false);
    expect(HistoryQuery.safeParse({ limit: '101' }).success).toBe(false);
  });
});
