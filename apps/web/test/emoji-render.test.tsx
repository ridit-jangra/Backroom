import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { CustomEmoji } from '@backroom/protocol';
import { DEFAULT_FREQUENT } from '@backroom/emoji';
import { MessageText } from '../src/components/MessageText';
import { EmojiProvider, useEmoji, type EmojiApi } from '../src/emoji/EmojiContext';
import { tokenize } from '../src/text/tokenize';
import { About } from '../src/pages/About';

afterEach(cleanup);
const ME = '01JME'.padEnd(26, '0');
const partypartyparrotId = '01JPARROT'.padEnd(26, '0');
const ppId = '01JPP'.padEnd(26, '0');
const partyparrot: CustomEmoji = {
  id: partypartyparrotId, name: 'partyparrot', url: `/emoji/${partypartyparrotId}`, aliasFor: null, createdBy: ME, createdAt: 1,
};
const pp: CustomEmoji = { id: ppId, name: 'pp', url: null, aliasFor: 'partyparrot', createdBy: ME, createdAt: 2 };

describe('emoji rendering', () => {
  it('renders twemoji with char alt and :name: title', () => {
    const { container } = render(<MessageText body=":thumbsup:" members={[]} me={ME} />);
    const img = container.querySelector('img[src="/twemoji/1f44d.svg"]')!;
    expect(img).not.toBeNull();
    expect(img.getAttribute('alt')).toBe('👍');
    expect(img.getAttribute('title')).toBe(':thumbsup:');
    expect(img.className).toContain('emoji');
    expect(img.getAttribute('draggable')).toBe('false');
    expect(img.getAttribute('loading')).toBe('lazy');
  });

  it('custom emoji and custom alias render the custom image', () => {
    const { container } = render(
      <EmojiProvider userId={ME} custom={[partyparrot, pp]}>
        <MessageText body=":partyparrot: and :pp: :wave::skin-tone-2: :partyparrot::skin-tone-2:" members={[]} me={ME} />
      </EmojiProvider>,
    );
    const imgs = [...container.querySelectorAll(`img[src="/emoji/${partypartyparrotId}"]`)];
    expect(imgs.map((i) => i.getAttribute('title'))).toEqual([':partyparrot:', ':pp:', ':partyparrot:']);
    expect(imgs.map((i) => i.getAttribute('alt'))).toEqual([':partyparrot:', ':pp:', ':partyparrot:']);
    expect(container.querySelector('img[title=":wave::skin-tone-2:"]')).not.toBeNull();
    // A custom emoji takes no tone: only the bare :partyparrot: part resolves.
    expect(container.querySelector('img[title=":partyparrot::skin-tone-2:"]')).toBeNull();
  });

  it('an alias whose target is gone stays text', () => {
    const { container } = render(
      <EmojiProvider userId={ME} custom={[pp]}>
        <MessageText body=":pp:" members={[]} me={ME} />
      </EmojiProvider>,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe(':pp:');
  });

  it('emoji-only messages get the jumbo class', () => {
    const { container, rerender } = render(<MessageText body=":+1: :tada:" members={[]} me={ME} />);
    expect(container.querySelector('.msg-text.jumbo')).not.toBeNull();
    rerender(<MessageText body=":+1: hi" members={[]} me={ME} />);
    expect(container.querySelector('.msg-text')).not.toBeNull();
    expect(container.querySelector('.msg-text.jumbo')).toBeNull();
  });

  it('colon-heavy text renders inert and fast', () => {
    const body = `10:30:45 :::: :qq:rr:ss: :<b>x</b>: ${':zq'.repeat(50_000)}`;
    const t0 = performance.now();
    tokenize(body);
    expect(performance.now() - t0).toBeLessThan(50);
    const { container } = render(<MessageText body={body} members={[]} me={ME} />);
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe(body);
  });

  it('EmojiApi resolves, canonicalizes and falls back without a provider', () => {
    let api: EmojiApi | undefined;
    function Grab() {
      api = useEmoji();
      return null;
    }
    render(<Grab />);
    expect(api!.isKnown('partyparrot', null)).toBe(false);
    expect(api!.frequent).toEqual(DEFAULT_FREQUENT);
    expect(api!.skinTone).toBe(1);
    cleanup();
    const thumbs: CustomEmoji = { ...pp, id: '01JTH'.padEnd(26, '0'), name: 'yes', aliasFor: 'thumbsup' };
    render(
      <EmojiProvider userId={ME} custom={[partyparrot, pp, thumbs]}>
        <Grab />
      </EmojiProvider>,
    );
    expect(api!.canonical('thumbsup', null)).toBe('+1');
    expect(api!.canonical('+1', 3)).toBe('+1::skin-tone-3');
    expect(api!.canonical('pp', null)).toBe('partyparrot');
    expect(api!.canonical('yes', null)).toBe('+1');
    expect(api!.canonical('partyparrot', 2)).toBeNull();
    expect(api!.canonical('nope', null)).toBeNull();
    expect(api!.resolve('yes', null)).toEqual({ src: '/twemoji/1f44d.svg', alt: ':yes:', title: ':yes:' });
    expect(api!.resolve('wave', 3)!.title).toBe(':wave::skin-tone-3:');
  });

  it('About page shows the Twemoji attribution', () => {
    render(<About />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('About Backroom');
    expect(screen.getByText('Emoji graphics by Twemoji, CC-BY 4.0')).toBeTruthy();
    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('https://creativecommons.org/licenses/by/4.0/');
    expect(hrefs).toContain('https://github.com/jdecked/twemoji');
    expect(screen.getByText('Emoji data from emoji-datasource (MIT).')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to chat' })).toBeTruthy();
  });
});
