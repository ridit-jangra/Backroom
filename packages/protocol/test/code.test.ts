import { describe, expect, it } from 'vitest';
import { findCodeRanges, maskCode } from '../src';

describe('findCodeRanges', () => {
  it('finds several spans on one line', () => {
    expect(findCodeRanges('a `b` c `d`')).toEqual([
      { start: 2, end: 5, kind: 'code', text: 'b' },
      { start: 8, end: 11, kind: 'code', text: 'd' },
    ]);
  });
  it('a lone backtick or one closing on another line is plain', () => {
    expect(findCodeRanges('a ` b')).toEqual([]);
    expect(findCodeRanges('`a\nb`')).toEqual([]);
  });
  it('fences ignore a language word; unclosed fences are plain', () => {
    expect(findCodeRanges('```ts\nlet a = 1;\n```')).toEqual([{ start: 0, end: 20, kind: 'codeblock', text: 'let a = 1;' }]);
    expect(findCodeRanges('```\nx\n```')[0]).toMatchObject({ text: 'x' });
    expect(findCodeRanges('```\nx')).toEqual([]);
  });
  it('maskCode keeps length', () => {
    const s = 'a `b@here` c';
    expect(maskCode(s)).toHaveLength(s.length);
    expect(maskCode(s)).not.toContain('@here');
  });
});

describe('findCodeRanges edge cases', () => {
  const texts = (b: string) => findCodeRanges(b).map((r) => [r.kind, r.text]);
  it.each([
    ['crlf fence', '```js\r\nlet a\r\n```', [['codeblock', 'let a']]],
    ['fence on one line', '```a```', [['codeblock', 'a']]],
    ['backtick inside a fence', '```\na ` b\n```', [['codeblock', 'a ` b']]],
    ['fence closing mid-line', '```\nfoo``` bar', [['codeblock', 'foo']]],
    ['double-backtick span with inner single', '`` `@here` ``', [['code', ' `@here` ']]],
    ['double span, longer run inside is content', '``a```b``', [['code', 'a```b']]],
    ['single span ignores a double run inside', '`a``b`', [['code', 'a``b']]],
    ['four-backtick fence closes on four', '````\n```\nx\n```\n````', [['codeblock', '```\nx\n```']]],
    ['unclosed four-backtick fence is plain', '````\nx\n```', []],
    ['empty fence with language is plain', '```js\n```', []],
    ['blank fence is plain', '```\n\n```', []],
    ['six backticks are plain', '``````', []],
  ])('%s', (_n, body, want) => {
    expect(texts(body)).toEqual(want);
  });
  it('extractMentions sees no broadcast in a double-backtick span', async () => {
    const { extractMentions } = await import('../src');
    expect(extractMentions('`` `@here` ``')).toEqual({ userIds: [], channel: false, here: false });
  });
});
