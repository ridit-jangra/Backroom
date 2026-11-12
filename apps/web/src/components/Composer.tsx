import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { MAX_BODY, TYPING_THROTTLE_MS, type MemberSummary } from '@backroom/protocol';
import { formatShortcode } from '@backroom/emoji';
import { decodeMentions, encodeMentions } from '../text/tokenize';
import { useEmoji } from '../emoji/EmojiContext';
import { EmojiImg } from '../emoji/EmojiImg';
import { EmojiPicker } from '../emoji/EmojiPicker';
import { suggestEmoji } from '../emoji/suggest';

const MENTION_QUERY_RE = /(?:^|\s)@([^\s@]+)$/;
const EMOJI_QUERY_RE = /(?:^|\s):([A-Za-z0-9_+-]{2,})$/;
const MAX_SUGGESTIONS = 8;

export function Composer({
  placeholder,
  members,
  initial,
  onSubmit,
  onTyping,
  onCancel,
}: {
  placeholder: string;
  members: MemberSummary[];
  initial?: string;
  /** Return false to keep the text (e.g. not connected). */
  onSubmit: (body: string) => boolean | void;
  onTyping?: () => void;
  onCancel?: () => void;
}) {
  // P2-R25: per-instance ids so two composers (channel + thread) can coexist.
  const uid = useId();
  const listboxId = `${uid}-listbox`;
  const optionId = (memberId: string) => `${uid}-opt-${memberId}`;
  const init = useMemo(() => decodeMentions(initial ?? '', members), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [text, setText] = useState(init.text);
  const picked = useRef<Map<string, string>>(init.picked);
  const lastTyping = useRef<number | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [caret, setCaret] = useState(init.text.length);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const emoji = useEmoji();

  const encoded = encodeMentions(text, picked.current);
  const tooLong = encoded.length > MAX_BODY;

  const query = MENTION_QUERY_RE.exec(text.slice(0, caret))?.[1];
  const matches = useMemo(() => {
    if (query === undefined || dismissed) return [];
    const q = query.toLowerCase();
    return members.filter((m) => !m.deactivated && m.displayName.toLowerCase().startsWith(q)).slice(0, MAX_SUGGESTIONS);
  }, [query, members, dismissed]);
  const open = matches.length > 0;

  const emojiQuery = EMOJI_QUERY_RE.exec(text.slice(0, caret))?.[1];
  const emojiMatches = useMemo(() => {
    if (emojiQuery === undefined || dismissed) return [];
    return suggestEmoji(emojiQuery, emoji.custom, MAX_SUGGESTIONS);
  }, [emojiQuery, emoji.custom, dismissed]);
  const emojiOpen = !open && emojiMatches.length > 0;
  const emojiCode = (m: (typeof emojiMatches)[number]) =>
    m.kind === 'custom' ? m.name : formatShortcode(m.name, m.record.skins ? emoji.skinTone : null);
  const emojiOptionId = (i: number) => `${uid}-emoji-${i}`;
  const listOpen = open || emojiOpen;
  const activeIdx = Math.min(active, Math.max((open ? matches.length : emojiMatches.length) - 1, 0));

  function place(next: string, pos: number) {
    setText(next);
    setCaret(pos);
    setActive(0);
    requestAnimationFrame(() => {
      area.current?.focus();
      area.current?.setSelectionRange(pos, pos);
    });
  }

  function insertEmoji(m: (typeof emojiMatches)[number]) {
    const code = emojiCode(m);
    const start = caret - (emojiQuery?.length ?? 0) - 1;
    const ins = `:${code}: `;
    // The frequent list tracks the primary name, not the alias the user typed.
    emoji.recordUse(emoji.canonical(m.name, m.kind === 'builtin' && m.record.skins ? emoji.skinTone : null) ?? code);
    place(`${text.slice(0, start)}${ins}${text.slice(caret)}`, start + ins.length);
  }

  function insertPicked(code: string) {
    const before = text.slice(0, caret);
    const ins = `${before === '' || /\s$/.test(before) ? '' : ' '}:${code}: `;
    place(`${before}${ins}${text.slice(caret)}`, before.length + ins.length);
    setPickerOpen(false);
  }

  function insert(m: MemberSummary) {
    const before = text.slice(0, caret);
    const start = before.length - (query?.length ?? 0) - 1;
    const next = `${text.slice(0, start)}@${m.displayName} ${text.slice(caret)}`;
    const pos = start + m.displayName.length + 2;
    picked.current.set(m.displayName, m.id);
    setText(next);
    setCaret(pos);
    setActive(0);
    requestAnimationFrame(() => area.current?.setSelectionRange(pos, pos));
  }

  function submit() {
    const body = encoded.trimEnd();
    if (body === '' || body.length > MAX_BODY) return;
    if (onSubmit(body) === false) return;
    setText('');
    setCaret(0);
    picked.current = new Map();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    if (emojiOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((a) => (a + 1) % emojiMatches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => (a - 1 + emojiMatches.length) % emojiMatches.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertEmoji(emojiMatches[activeIdx]!);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissed(true);
        return;
      }
    }
    if (open) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((a) => (a + 1) % matches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => (a - 1 + matches.length) % matches.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insert(matches[Math.min(active, matches.length - 1)]!);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissed(true);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      onCancel?.();
    }
  }

  return (
    <div className="composer">
      {emojiOpen && (
        <ul id={listboxId} role="listbox" aria-label="Emoji suggestions" className="mention-list">
          {emojiMatches.map((m, i) => {
            const r = emoji.resolve(m.name, m.kind === 'builtin' && m.record.skins ? emoji.skinTone : null);
            return (
              <li
                key={`${m.kind}-${m.name}`}
                id={emojiOptionId(i)}
                role="option"
                aria-selected={i === activeIdx}
                className={i === activeIdx ? 'active' : undefined}
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertEmoji(m);
                }}
              >
                {r && <EmojiImg e={r} />} :{m.name}:
              </li>
            );
          })}
        </ul>
      )}
      {open && (
        <ul id={listboxId} role="listbox" aria-label="Mention suggestions" className="mention-list">
          {matches.map((m, i) => (
            <li
              key={m.id}
              id={optionId(m.id)}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : undefined}
              onMouseDown={(e) => {
                e.preventDefault();
                insert(m);
              }}
            >
              {m.displayName}
            </li>
          ))}
        </ul>
      )}
      <textarea
        ref={area}
        aria-label={placeholder}
        aria-controls={listOpen ? listboxId : undefined}
        aria-expanded={listOpen}
        aria-activedescendant={
          open ? optionId(matches[activeIdx]!.id) : emojiOpen ? emojiOptionId(activeIdx) : undefined
        }
        placeholder={placeholder}
        value={text}
        rows={2}
        onChange={(e) => {
          const v = e.target.value;
          setText(v);
          setCaret(e.target.selectionStart ?? v.length);
          setActive(0);
          setDismissed(false);
          if (v !== '') {
            const now = Date.now();
            if (lastTyping.current === null || now - lastTyping.current >= TYPING_THROTTLE_MS) {
              lastTyping.current = now;
              onTyping?.();
            }
          }
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? text.length)}
        onKeyDown={onKeyDown}
      />
      <button
        type="button"
        aria-label="Emoji"
        aria-haspopup="dialog"
        aria-expanded={pickerOpen}
        ref={trigger}
        data-emoji-trigger
        className="emoji-trigger"
        onClick={() => setPickerOpen((o) => !o)}
      >
        ☺
      </button>
      {pickerOpen && <EmojiPicker label="Insert emoji" trigger={trigger} onPick={insertPicked} onClose={() => setPickerOpen(false)} />}
      {tooLong && <p role="alert">Message is too long (max 40,000 characters).</p>}
    </div>
  );
}
