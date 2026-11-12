import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Composer } from '../src/components/Composer';
import { EmojiProvider } from '../src/emoji/EmojiContext';

vi.mock('../src/files/upload');
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const A = '01HZZZZZZZZZZZZZZZZZZZZZZA';
const members = [
  { id: A, displayName: 'Ann Lee', role: 'member' as const, avatarKey: null },
  { id: '01HZZZZZZZZZZZZZZZZZZZZZZB', displayName: 'Bob', role: 'member' as const, avatarKey: null },
];

function setup(props: Partial<Parameters<typeof Composer>[0]> = {}) {
  const onSubmit = vi.fn();
  render(<Composer placeholder="Message" members={members} onSubmit={onSubmit} {...props} />);
  return { onSubmit, ta: screen.getByLabelText('Message') as HTMLTextAreaElement };
}
const type = (ta: HTMLTextAreaElement, v: string) => fireEvent.change(ta, { target: { value: v } });

describe('Composer', () => {
  it('Enter sends trimmed-nonempty text and clears', () => {
    const { onSubmit, ta } = setup();
    type(ta, 'hello');
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('hello');
    expect(ta.value).toBe('');
  });
  it('Shift+Enter inserts newline without sending', () => {
    const { onSubmit, ta } = setup();
    type(ta, 'a');
    fireEvent.keyDown(ta, { key: 'Enter', shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });
  it('Enter during IME composition does not send', () => {
    const { onSubmit, ta } = setup();
    type(ta, 'a');
    fireEvent.keyDown(ta, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(ta, { key: 'Enter', keyCode: 229 });
    expect(onSubmit).not.toHaveBeenCalled();
  });
  it('whitespace-only is not sent', () => {
    const { onSubmit, ta } = setup();
    type(ta, '   \n ');
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
  });
  it('40,001 chars shows the limit message and does not send', () => {
    const { onSubmit, ta } = setup();
    type(ta, 'a'.repeat(40_001));
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('Message is too long (max 40,000 characters).')).toBeTruthy();
  });
  it('limit is checked on the encoded body', () => {
    const { onSubmit, ta } = setup();
    fireEvent.change(ta, { target: { value: '@an', selectionStart: 3 } });
    fireEvent.keyDown(ta, { key: 'Enter' }); // picks Ann Lee
    const raw = 'x'.repeat(39_980) + ' @Ann Lee'; // 39,989 raw, 40,009 encoded
    type(ta, raw);
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('Message is too long (max 40,000 characters).')).toBeTruthy();
  });
  it('autocomplete inserts @Name and submits a <@id> token', () => {
    const { onSubmit, ta } = setup();
    ta.setSelectionRange(0, 0);
    fireEvent.change(ta, { target: { value: '@an', selectionStart: 3 } });
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(screen.getAllByRole('option')).toHaveLength(1);
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(ta.value).toBe('@Ann Lee ');
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith(`<@${A}>`);
  });
  it('edit mode decodes initial mentions and re-encodes', () => {
    const { onSubmit, ta } = setup({ initial: `hi <@${A}>` });
    expect(ta.value).toBe('hi @Ann Lee');
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith(`hi <@${A}>`);
  });
  it('onTyping is throttled to once per 3 s', () => {
    vi.useFakeTimers();
    const onTyping = vi.fn();
    const { ta } = setup({ onTyping });
    type(ta, 'a');
    type(ta, 'ab');
    expect(onTyping).toHaveBeenCalledTimes(1);
    act(() => void vi.advanceTimersByTime(3000));
    type(ta, 'abc');
    expect(onTyping).toHaveBeenCalledTimes(2);
  });
  it('bare @ does not open autocomplete and Enter sends', () => {
    const { onSubmit, ta } = setup();
    fireEvent.change(ta, { target: { value: 'see you @', selectionStart: 9 } });
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('see you @');
  });
  it('trims trailing whitespace of the submitted body', () => {
    const { onSubmit, ta } = setup();
    type(ta, 'hi  \n');
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('hi');
  });
  it('Escape calls onCancel', () => {
    const onCancel = vi.fn();
    const { ta } = setup({ onCancel });
    fireEvent.keyDown(ta, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
  });
  it('ArrowDown + Enter picks the second option; aria wiring', () => {
    const many = [...members, { id: '01HZZZZZZZZZZZZZZZZZZZZZZC', displayName: 'Anna', role: 'member' as const, avatarKey: null }];
    const onSubmit = vi.fn();
    render(<Composer placeholder="M2" members={many} onSubmit={onSubmit} />);
    const ta = screen.getByLabelText('M2') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: '@an', selectionStart: 3 } });
    expect(ta.getAttribute('aria-expanded')).toBe('true');
    const listbox = screen.getByRole('listbox');
    expect(listbox.id).not.toBe('');
    expect(ta.getAttribute('aria-controls')).toBe(listbox.id);
    fireEvent.keyDown(ta, { key: 'ArrowDown' });
    const anna = screen.getByRole('option', { name: 'Anna' });
    expect(anna.id).toContain('01HZZZZZZZZZZZZZZZZZZZZZZC');
    expect(ta.getAttribute('aria-activedescendant')).toBe(anna.id);
    expect(document.getElementById(anna.id)).toBe(anna);
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(ta.value).toBe('@Anna ');
  });
  it('two composers get distinct listbox ids (P2-R25)', () => {
    render(<Composer placeholder="C1" members={members} onSubmit={() => {}} />);
    render(<Composer placeholder="C2" members={members} onSubmit={() => {}} />);
    const a = screen.getByLabelText('C1');
    const b = screen.getByLabelText('C2');
    fireEvent.change(a, { target: { value: '@b', selectionStart: 2 } });
    fireEvent.change(b, { target: { value: '@b', selectionStart: 2 } });
    const ids = screen.getAllByRole('listbox').map((l) => l.id);
    expect(new Set(ids).size).toBe(2);
    expect(a.getAttribute('aria-controls')).not.toBe(b.getAttribute('aria-controls'));
  });
});

describe('Composer emoji', () => {
  const ME = '01JME'.padEnd(26, '0');
  const pid = '01JPARROT'.padEnd(26, '0');
  const parrot = { id: pid, name: 'thumbparrot', url: `/emoji/${pid}`, aliasFor: null, createdBy: ME, createdAt: 1 };
  function emojiSetup(custom: (typeof parrot)[] = [], tone?: number) {
    localStorage.clear();
    if (tone) localStorage.setItem(`backroom:emoji:${ME}`, JSON.stringify({ skinTone: tone, uses: {} }));
    const onSubmit = vi.fn();
    render(
      <EmojiProvider userId={ME} custom={custom}>
        <Composer placeholder="Message" members={members} onSubmit={onSubmit} />
      </EmojiProvider>,
    );
    return { onSubmit, ta: screen.getByLabelText('Message') as HTMLTextAreaElement };
  }
  const opts = () => screen.queryAllByRole('option').map((o) => o.textContent!.trim());

  it('":thu" suggests matched names and Tab inserts the code', () => {
    const { onSubmit, ta } = emojiSetup();
    type(ta, ':thu');
    expect(screen.getByRole('listbox', { name: 'Emoji suggestions' })).toBeTruthy();
    expect(opts().slice(0, 2)).toEqual([':thumbsup:', ':thumbsdown:']);
    fireEvent.keyDown(ta, { key: 'Tab' });
    expect(ta.value).toBe(':thumbsup: ');
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith(':thumbsup:');
  });

  it('no suggestions for ":)", "10:30" or a 1-char query', () => {
    const { ta } = emojiSetup();
    for (const v of [':)', '10:30', ':t']) {
      type(ta, v);
      expect(screen.queryByRole('listbox')).toBeNull();
    }
  });

  it('Escape dismisses suggestions', () => {
    const { ta } = emojiSetup();
    type(ta, ':thu');
    fireEvent.keyDown(ta, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('custom emoji are suggested first', () => {
    const { ta } = emojiSetup([parrot]);
    type(ta, ':thumb');
    expect(opts()[0]).toBe(':thumbparrot:');
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(ta.value).toBe(':thumbparrot: ');
  });

  it('emoji button inserts at the caret', () => {
    const { ta } = emojiSetup();
    type(ta, 'hi');
    fireEvent.click(screen.getByRole('button', { name: 'Emoji' }));
    expect(screen.getByRole('dialog', { name: 'Insert emoji' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search emoji'), { target: { value: 'tada' } });
    fireEvent.keyDown(screen.getByLabelText('Search emoji'), { key: 'Enter' });
    expect(ta.value).toBe('hi :tada: ');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('skin tone preference is applied to toneable suggestions', () => {
    const { ta } = emojiSetup([], 3);
    type(ta, ':wav');
    fireEvent.keyDown(ta, { key: 'Tab' });
    expect(ta.value).toBe(':wave::skin-tone-3: ');
  });

  it('picked and suggested emoji record the primary name, not the typed alias', () => {
    const { ta } = emojiSetup();
    type(ta, ':thumbsup');
    fireEvent.keyDown(ta, { key: 'Tab' });
    expect(ta.value).toBe(':thumbsup: ');
    const uses = Object.keys(JSON.parse(localStorage.getItem(`backroom:emoji:${ME}`)!).uses);
    expect(uses).toEqual(['+1']);
  });

  it('Escape in the picker closes it without cancelling an edit composer', () => {
    const onCancel = vi.fn();
    localStorage.clear();
    render(
      <EmojiProvider userId={ME} custom={[]}>
        <Composer placeholder="Edit message" members={members} onSubmit={vi.fn()} onCancel={onCancel} />
      </EmojiProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Emoji' }));
    fireEvent.keyDown(screen.getByLabelText('Search emoji'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('opening one composer picker and clicking another trigger never leaves two pickers open', () => {
    localStorage.clear();
    render(
      <EmojiProvider userId={ME} custom={[]}>
        <Composer placeholder="First" members={members} onSubmit={vi.fn()} />
        <Composer placeholder="Second" members={members} onSubmit={vi.fn()} />
      </EmojiProvider>,
    );
    const [a, b] = screen.getAllByRole('button', { name: 'Emoji' }) as [HTMLElement, HTMLElement];
    fireEvent.click(a);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    fireEvent.mouseDown(b);
    fireEvent.click(b);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(b.getAttribute('aria-expanded')).toBe('true');
    expect(a.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('Composer attachments', () => {
  const info = (id: string, name: string) => ({ id, name, mime: 'image/png', size: 1, width: null, height: null, hasThumb: false });
  type Call = { file: File; signal?: AbortSignal; resolve: (v: ReturnType<typeof info>) => void; reject: (e: Error) => void };

  async function attachSetup() {
    const up = await import('../src/files/upload');
    const calls: Call[] = [];
    vi.mocked(up.uploadFile).mockImplementation(
      (_slug, file, opts) =>
        new Promise((resolve, reject) => {
          calls.push({ file, signal: opts?.signal, resolve: resolve as Call['resolve'], reject });
        }),
    );
    vi.mocked(up.makeThumbnail).mockResolvedValue(null);
    const r = setup({ uploadSlug: 'w' });
    return { ...r, calls, up };
  }
  const file = (name: string, size = 1) => {
    const f = new File(['x'], name, { type: 'image/png' });
    if (size !== 1) Object.defineProperty(f, 'size', { value: size });
    return f;
  };
  const choose = (files: File[]) => fireEvent.change(screen.getByTestId('file-input'), { target: { files } });

  it('attach, upload, then send files with or without text', async () => {
    const { onSubmit, ta, calls } = await attachSetup();
    choose([file('a.png'), file('b.png')]);
    expect(document.querySelectorAll('.upload-list li')).toHaveLength(2);
    expect(screen.getByLabelText('Uploading a.png')).toBeTruthy();
    await act(async () => {
      calls[0]!.resolve(info('A', 'a.png'));
      calls[1]!.resolve(info('B', 'b.png'));
    });
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('', [info('A', 'a.png'), info('B', 'b.png')]);
    expect(document.querySelectorAll('.upload-list li')).toHaveLength(0);
  });

  it('paste and drop add files', async () => {
    const { ta, calls, container } = await attachSetup().then((r) => ({ ...r, container: document.body }));
    fireEvent.paste(ta, { clipboardData: { files: [file('p.png')] } });
    fireEvent.drop(container.querySelector('.composer')!, { dataTransfer: { files: [file('g.png')], types: ['Files'] } });
    expect(calls).toHaveLength(2);
  });

  it('cancel, failure and limits never block or corrupt the send', async () => {
    const { onSubmit, ta, calls, up } = await attachSetup();
    choose(Array.from({ length: 12 }, (_, i) => file(`f${i}.png`)));
    expect(calls).toHaveLength(10);
    expect(screen.getByRole('alert').textContent).toBe('You can attach up to 10 files.');
    cleanup();

    const s2 = await attachSetup();
    choose([file('big.bin', 30 * 1024 * 1024)]);
    expect(screen.getByRole('alert').textContent).toBe('"big.bin" is larger than 25 MB.');
    expect(s2.calls).toHaveLength(0);
    cleanup();

    const s3 = await attachSetup();
    choose([file('a.png'), file('c.png')]);
    type(s3.ta, 'hi');
    fireEvent.keyDown(s3.ta, { key: 'Enter' });
    expect(s3.onSubmit).not.toHaveBeenCalled();
    expect(s3.ta.value).toBe('hi');
    fireEvent.click(screen.getByLabelText('Remove a.png'));
    expect(s3.calls[0]!.signal!.aborted).toBe(true);
    expect(screen.queryByLabelText('Remove a.png')).toBeNull();
    await act(async () => {
      s3.calls[1]!.reject(new Error('boom'));
    });
    expect(screen.getByText('boom')).toBeTruthy();
    fireEvent.click(screen.getByText('Retry'));
    expect(s3.calls).toHaveLength(3);
    await act(async () => {
      s3.calls[2]!.resolve(info('C', 'c.png'));
    });
    fireEvent.keyDown(s3.ta, { key: 'Enter' });
    expect(s3.onSubmit).toHaveBeenCalledWith('hi', [info('C', 'c.png')]);
    void onSubmit; void ta; void up;
  });

  it('no attach button without uploadSlug', () => {
    setup();
    expect(screen.queryByLabelText('Attach files')).toBeNull();
  });
});
