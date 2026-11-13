import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { decodeMentions, encodeMentions, isEmojiOnly, JUMBO_MAX, tokenize } from '../src/text/tokenize';
import { MessageText } from '../src/components/MessageText';

afterEach(cleanup);
const A = '01HZZZZZZZZZZZZZZZZZZZZZZA';
const ann = { id: A, displayName: 'Ann Lee', role: 'member' as const, avatarKey: null };

describe('tokenize', () => {
  it('renders markup as text and links only http(s)', () => {
    expect(tokenize('<img src=x onerror=alert(1)>')).toEqual([{ kind: 'text', text: '<img src=x onerror=alert(1)>' }]);
    expect(tokenize('javascript:alert(1)').every((t) => t.kind === 'text')).toBe(true);
    expect(tokenize('see (https://ex.com/a_(b)).')).toEqual([
      { kind: 'text', text: 'see (' },
      { kind: 'link', href: 'https://ex.com/a_(b)', text: 'https://ex.com/a_(b)' },
      { kind: 'text', text: ').' },
    ]);
    const long = 'https://ex.com/' + 'a'.repeat(1985);
    expect(long.length).toBe(2000);
    expect(tokenize(long)).toEqual([{ kind: 'link', href: long, text: long }]);
    const { container } = render(<MessageText body={long} members={[]} me={A} />);
    expect(container.querySelector('.msg-text')).not.toBeNull();
  });
  it('tokenizes users and broadcasts with the protocol boundary rule', () => {
    expect(tokenize(`<@${A}> @here a@channel @channel!`)).toEqual([
      { kind: 'user', userId: A },
      { kind: 'text', text: ' ' },
      { kind: 'broadcast', which: 'here' },
      { kind: 'text', text: ' a@channel ' },
      { kind: 'broadcast', which: 'channel' },
      { kind: 'text', text: '!' },
    ]);
  });
  it('encode/decode mentions round-trip', () => {
    const picked = new Map([['Ann Lee', A]]);
    expect(encodeMentions('hi @Ann Lee!', picked)).toBe(`hi <@${A}>!`);
    expect(decodeMentions(`hi <@${A}>!`, [ann]).text).toBe('hi @Ann Lee!');
    expect(decodeMentions(`<@${A}>`, []).text).toBe(`<@${A}>`);
  });
});

describe('MessageText', () => {
  it('never injects HTML; one safe link; mention name', () => {
    const { container } = render(<MessageText body={`<b>x</b> <@${A}> https://ex.com`} members={[ann]} me="other" />);
    expect(container.querySelector('b')).toBeNull();
    const links = container.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute('href')).toBe('https://ex.com');
    expect(links[0]!.getAttribute('rel')).toBe('noopener noreferrer nofollow');
    expect(container.textContent).toContain('@Ann Lee');
  });
});

describe('tokenize hardening', () => {
  it('trims many trailing parens in linear time', () => {
    const t0 = performance.now();
    const out = tokenize('https://x' + ')'.repeat(39_990));
    expect(performance.now() - t0).toBeLessThan(50);
    expect(out[0]).toEqual({ kind: 'link', href: 'https://x', text: 'https://x' });
    expect(out[1]).toEqual({ kind: 'text', text: ')'.repeat(39_990) });
  });
  it('keeps balanced parens', () => {
    const u = 'https://en.wikipedia.org/wiki/Foo_(bar)';
    expect(tokenize(u)).toEqual([{ kind: 'link', href: u, text: u }]);
  });
  it('non-http schemes stay text', () => {
    for (const s of ['data:text/html,x', 'vbscript:x', 'HTTP:evil']) {
      expect(tokenize(s).every((t) => t.kind === 'text')).toBe(true);
    }
  });
  it('does not encode a name glued to a preceding word char', () => {
    expect(encodeMentions('bob@Ann Lee', new Map([['Ann Lee', A]]))).toBe('bob@Ann Lee');
  });
  it('@here inside a URL is only a link', () => {
    expect(tokenize('https://ex.com/@here').map((t) => t.kind)).toEqual(['link']);
  });
});

describe('MessageText details', () => {
  it('link target, me class, unknown user', () => {
    const { container } = render(
      <MessageText body={`https://ex.com <@${A}> <@01HZZZZZZZZZZZZZZZZZZZZZZZ> @here`} members={[ann]} me={A} />,
    );
    expect(container.querySelector('a')!.getAttribute('target')).toBe('_blank');
    expect(container.querySelector('.mention.me')!.textContent).toBe('@Ann Lee');
    expect(container.textContent).toContain('@unknown');
    expect(container.textContent).toContain('@here');
  });
});

describe('tokenize emoji', () => {
  it('shortcodes become emoji tokens; unknown stay text', () => {
    expect(tokenize('hi :wave::skin-tone-3: :nope:')).toEqual([
      { kind: 'text', text: 'hi ' },
      { kind: 'emoji', name: 'wave', tone: 3, text: ':wave::skin-tone-3:' },
      { kind: 'text', text: ' :nope:' },
    ]);
  });
  it('a code inside a URL stays in the link', () => {
    // P3-R3: Phase 2 trimLink strips the trailing ':'; the emoji span overlaps the link and is dropped.
    expect(tokenize('https://ex.com/:smile:')).toEqual([
      { kind: 'link', text: 'https://ex.com/:smile', href: 'https://ex.com/:smile' },
      { kind: 'text', text: ':' },
    ]);
  });
  it('custom names are known only through the predicate', () => {
    expect(tokenize(':partyparrot:')).toEqual([{ kind: 'text', text: ':partyparrot:' }]);
    expect(tokenize(':partyparrot:', (n) => n === 'partyparrot')).toEqual([
      { kind: 'emoji', name: 'partyparrot', tone: null, text: ':partyparrot:' },
    ]);
  });
  it('isEmojiOnly: ":+1: :tada:" true; ":+1: hi" false; 24 codes false; ":nope:" false', () => {
    expect(isEmojiOnly(tokenize(':+1: :tada:'))).toBe(true);
    expect(isEmojiOnly(tokenize(' :+1:\n'))).toBe(true);
    expect(isEmojiOnly(tokenize(':+1: hi'))).toBe(false);
    expect(isEmojiOnly(tokenize(':+1:'.repeat(JUMBO_MAX)))).toBe(true);
    expect(isEmojiOnly(tokenize(':+1:'.repeat(24)))).toBe(false);
    expect(isEmojiOnly(tokenize(':nope:'))).toBe(false);
    expect(isEmojiOnly(tokenize(''))).toBe(false);
  });
});

describe('code spans and blocks', () => {
  const kinds = (b: string) => tokenize(b).map((t) => t.kind);
  it('nothing inside code becomes a mention, broadcast, link or emoji', () => {
    expect(tokenize(`\`<@${A}>\``)).toEqual([{ kind: 'code', text: `<@${A}>` }]);
    expect(tokenize('`@here`')).toEqual([{ kind: 'code', text: '@here' }]);
    expect(tokenize('`http://a`')).toEqual([{ kind: 'code', text: 'http://a' }]);
    expect(tokenize('`:smile:`')).toEqual([{ kind: 'code', text: ':smile:' }]);
    expect(tokenize('```\nhttp://a :smile: @channel\n```')).toEqual([{ kind: 'codeblock', text: 'http://a :smile: @channel' }]);
  });
  it('a link running into a backtick stops at the code', () => {
    expect(kinds('http://a.com`x`')).toEqual(['link', 'code']);
  });
  it('unclosed fences and lone backticks stay plain text', () => {
    expect(tokenize('```\nlet a')).toEqual([{ kind: 'text', text: '```\nlet a' }]);
    expect(tokenize('a ` b')).toEqual([{ kind: 'text', text: 'a ` b' }]);
    expect(tokenize('`a\nb`')).toEqual([{ kind: 'text', text: '`a\nb`' }]);
  });
  it('multiple spans on one line', () => {
    expect(tokenize('`a` and `b`')).toEqual([
      { kind: 'code', text: 'a' },
      { kind: 'text', text: ' and ' },
      { kind: 'code', text: 'b' },
    ]);
  });
  it('a fence with a language word ignores the word', () => {
    expect(tokenize('```js\nconst a = `x`;\n```')).toEqual([{ kind: 'codeblock', text: 'const a = `x`;' }]);
  });
  it('code beside real mention, link and emoji leaves them intact', () => {
    expect(kinds(`\`a\` <@${A}> \`b\` https://ex.com \`c\` :smile: \`d\``)).toEqual([
      'code', 'text', 'user', 'text', 'code', 'text', 'link', 'text', 'code', 'text', 'emoji', 'text', 'code',
    ]);
  });
  it('code is never jumbo emoji', () => {
    expect(isEmojiOnly(tokenize('`:smile:`'))).toBe(false);
    expect(isEmojiOnly(tokenize(':smile: `x`'))).toBe(false);
  });
  it('renders <code> and <pre><code>', () => {
    const { container } = render(<MessageText body={'a `x` b\n```py\nprint(1)\n```'} members={[ann]} me={A} />);
    expect(container.querySelector('code')!.textContent).toBe('x');
    expect(container.querySelector('pre > code')!.textContent).toBe('print(1)');
    expect(container.querySelectorAll('code')).toHaveLength(2);
    expect(container.querySelector('code')!.closest('pre')).toBeNull();
    expect(container.querySelector('.msg-text.jumbo')).toBeNull();
  });
  it('drops the newline right after a code block so no blank line follows the pre', () => {
    const { container } = render(<MessageText body={'```\nx\n```\nafter'} members={[]} me={A} />);
    expect(container.querySelector('.msg-text')!.lastChild!.textContent).toBe('after');
    expect(tokenize('```\nx\n```\nafter')[1]).toEqual({ kind: 'text', text: '\nafter' });
  });
});
