import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { CustomEmoji } from '@backroom/protocol';
import { EmojiProvider } from '../src/emoji/EmojiContext';
import { EmojiPicker } from '../src/emoji/EmojiPicker';
import { loadPrefs } from '../src/emoji/prefs';

const ME = '01JME'.padEnd(26, '0');
const BOB = '01JBOB'.padEnd(26, '0');
const pid = '01JPARROT'.padEnd(26, '0');
const partyparrot: CustomEmoji = { id: pid, name: 'partyparrot', url: `/emoji/${pid}`, aliasFor: null, createdBy: ME, createdAt: 1 };

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount(opts: { user?: string; custom?: CustomEmoji[] } = {}) {
  const onPick = vi.fn();
  const onClose = vi.fn();
  const ui = (
    <EmojiProvider userId={opts.user ?? ME} custom={opts.custom ?? []}>
      <EmojiPicker label="Insert emoji" onPick={onPick} onClose={onClose} />
    </EmojiProvider>
  );
  const r = render(ui);
  return { onPick, onClose, ...r, ui };
}
const search = (v: string) => fireEvent.change(screen.getByLabelText('Search emoji'), { target: { value: v } });
const cells = () => within(screen.getByRole('grid')).getAllByRole('button');

describe('EmojiPicker', () => {
  it('search filters and Enter picks the first result', () => {
    const { onPick } = mount();
    expect(document.activeElement).toBe(screen.getByLabelText('Search emoji'));
    search('thumbs');
    expect(cells()[0]!.getAttribute('aria-label')).toBe(':+1:');
    fireEvent.keyDown(screen.getByLabelText('Search emoji'), { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith('+1');
  });

  it('shows "No emoji found"', () => {
    mount();
    search('zzzzqqqq');
    expect(screen.getByText('No emoji found')).toBeTruthy();
  });

  it('arrow keys move by 1 and by 8 in the grid', () => {
    mount();
    fireEvent.click(screen.getByRole('tab', { name: 'Smileys & Emotion' }));
    cells()[0]!.focus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(cells()[1]);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(cells()[9]);
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(document.activeElement).toBe(cells()[0]);
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(document.activeElement).toBe(cells()[cells().length - 1]);
  });

  it('ArrowDown in search focuses the first cell', () => {
    mount();
    fireEvent.keyDown(screen.getByLabelText('Search emoji'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(cells()[0]);
  });

  it('skin tone applies to toneable emoji only and persists per user', () => {
    const { onPick, unmount } = mount();
    fireEvent.click(screen.getByRole('radio', { name: 'Skin tone 3' }));
    search('wave');
    fireEvent.keyDown(screen.getByLabelText('Search emoji'), { key: 'Enter' });
    expect(onPick).toHaveBeenLastCalledWith('wave::skin-tone-3');
    search('heart');
    fireEvent.click(screen.getByRole('button', { name: ':heart:' }));
    expect(onPick).toHaveBeenLastCalledWith('heart');
    unmount();
    mount();
    expect(screen.getByRole('radio', { name: 'Skin tone 3' }).getAttribute('aria-checked')).toBe('true');
    cleanup();
    mount({ user: BOB });
    expect(screen.getByRole('radio', { name: 'Default skin tone' }).getAttribute('aria-checked')).toBe('true');
  });

  it('frequently used reflects picks', () => {
    mount();
    for (const n of ['tada', 'tada', 'fire']) {
      search(n);
      fireEvent.click(screen.getByRole('button', { name: `:${n}:` }));
    }
    search('');
    expect(screen.getByRole('tab', { name: 'Frequently used' }).getAttribute('aria-selected')).toBe('true');
    expect(cells().slice(0, 2).map((c) => c.getAttribute('aria-label'))).toEqual([':tada:', ':fire:']);
  });

  it('Custom tab lists workspace emoji', () => {
    const { onPick } = mount({ custom: [partyparrot] });
    fireEvent.click(screen.getByRole('tab', { name: 'Custom' }));
    const c = cells();
    expect(c.map((x) => x.getAttribute('aria-label'))).toEqual([':partyparrot:']);
    fireEvent.click(c[0]!);
    expect(onPick).toHaveBeenCalledWith('partyparrot');
    cleanup();
    mount();
    expect(screen.queryByRole('tab', { name: 'Custom' })).toBeNull();
  });

  it('custom names come first in search', () => {
    mount({ custom: [{ ...partyparrot, name: 'party_x' }] });
    search('party');
    expect(cells()[0]!.getAttribute('aria-label')).toBe(':party_x:');
  });

  it('Escape closes and restores focus to the trigger', () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <EmojiProvider userId={ME} custom={[]}>
          <button onClick={() => setOpen(true)}>trigger</button>
          {open && <EmojiPicker label="Insert emoji" onPick={() => undefined} onClose={() => setOpen(false)} />}
        </EmojiProvider>
      );
    }
    render(<Host />);
    const t = screen.getByText('trigger');
    t.focus();
    fireEvent.click(t);
    expect(screen.getByRole('dialog', { name: 'Insert emoji' })).toBeTruthy();
    fireEvent.keyDown(screen.getByLabelText('Search emoji'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(t);
  });

  it('Enter and Space on a grid cell do not pick by keydown (the native click does, once)', () => {
    const { onPick } = mount();
    search('tada');
    const cell = cells()[0]!;
    cell.focus();
    fireEvent.keyDown(cell, { key: 'Enter' });
    fireEvent.keyDown(cell, { key: ' ' });
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.click(cell);
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it('Escape is scoped to the picker: it stops propagating and closes', () => {
    const outer = vi.fn();
    const onClose = vi.fn();
    render(
      <div onKeyDown={outer}>
        <EmojiProvider userId={ME} custom={[]}>
          <EmojiPicker label="Insert emoji" onPick={() => undefined} onClose={onClose} />
        </EmojiProvider>
      </div>,
    );
    fireEvent.keyDown(screen.getByLabelText('Search emoji'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });

  it('closes when focus leaves the picker, but not for focus moving inside it', () => {
    const { onClose } = mount();
    const input = screen.getByLabelText('Search emoji');
    fireEvent.blur(input, { relatedTarget: screen.getByRole('radio', { name: 'Skin tone 2' }) });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.blur(input, { relatedTarget: null });
    expect(onClose).not.toHaveBeenCalled();
    const elsewhere = document.body.appendChild(document.createElement('button'));
    fireEvent.blur(input, { relatedTarget: elsewhere });
    expect(onClose).toHaveBeenCalledTimes(1);
    elsewhere.remove();
  });

  it('a click on a trigger other than the owner closes the picker', () => {
    const onClose = vi.fn();
    const trigger: { current: HTMLElement | null } = { current: null };
    render(
      <EmojiProvider userId={ME} custom={[]}>
        <button data-emoji-trigger ref={(el) => void (trigger.current = el)}>mine</button>
        <button data-emoji-trigger>other</button>
        <EmojiPicker
          label="Insert emoji"
          onPick={() => undefined}
          onClose={onClose}
          trigger={trigger}
        />
      </EmojiProvider>,
    );
    fireEvent.mouseDown(screen.getByText('mine'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(screen.getByText('other'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('click outside closes', () => {
    const { onClose } = mount();
    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalled();
  });

  it('works when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const { onPick } = mount();
    search('tada');
    fireEvent.keyDown(screen.getByLabelText('Search emoji'), { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith('tada');
  });
});

describe('prefs hardening (P3-R17a)', () => {
  it('drops malformed codes and caps to the 50 most recent', () => {
    const uses: Record<string, { n: number; at: number }> = { 'BAD CODE': { n: 1, at: 999 }, '<img>': { n: 1, at: 999 } };
    for (let i = 0; i < 80; i++) uses[`e${i}`] = { n: 1, at: i };
    localStorage.setItem(`backroom:emoji:${ME}`, JSON.stringify({ skinTone: 1, uses }));
    const keys = Object.keys(loadPrefs(ME).uses);
    expect(keys).toHaveLength(50);
    expect(keys).not.toContain('BAD CODE');
    expect(keys).toContain('e79');
    expect(keys).not.toContain('e0');
  });
});
