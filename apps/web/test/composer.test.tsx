import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Composer } from '../src/components/Composer';

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
    expect(onSubmit).toHaveBeenCalledWith(`<@${A}> `);
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
});
