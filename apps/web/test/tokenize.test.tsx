import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { decodeMentions, encodeMentions, tokenize } from '../src/text/tokenize';
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
