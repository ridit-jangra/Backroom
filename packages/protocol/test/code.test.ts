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
