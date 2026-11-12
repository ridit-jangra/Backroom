import { useId, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { MAX_BODY, TYPING_THROTTLE_MS, type FileInfo, type MemberSummary } from '@backroom/protocol';
import { formatShortcode } from '@backroom/emoji';
import { decodeMentions, encodeMentions } from '../text/tokenize';
import { useEmoji } from '../emoji/EmojiContext';
import { EmojiImg } from '../emoji/EmojiImg';
import { EmojiPicker } from '../emoji/EmojiPicker';
import { suggestEmoji } from '../emoji/suggest';
import { useUploads } from '../files/useUploads';

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
  uploadSlug,
}: {
  placeholder: string;
  members: MemberSummary[];
  initial?: string;
  /** Return false to keep the text (e.g. not connected). */
  onSubmit: (body: string, files: FileInfo[]) => boolean | void;
  onTyping?: () => void;
  onCancel?: () => void;
  /** Enables attachments (attach button, paste, drop). Edit composers omit it. */
  uploadSlug?: string;
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
  const uploads = useUploads(uploadSlug ?? '');
  const fileInput = useRef<HTMLInputElement>(null);
  const attach = uploadSlug !== undefined;

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
    if (body.length > MAX_BODY) return;
    if (attach) {
      if (uploads.busy) {
        uploads.blocked();
        return;
      }
      if (body === '' && uploads.ready.length === 0) return;
      if (onSubmit(body, uploads.ready) === false) return;
      uploads.clear();
    } else {
      if (body === '') return;
      // Edit-mode composers take no files; keep the single-argument call.
      if ((onSubmit as (b: string) => boolean | void)(body) === false) return;
    }
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

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (!attach || files.length === 0) return;
    e.preventDefault();
    uploads.add(files);
  }

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    if (attach && Array.from(e.dataTransfer?.types ?? []).includes('Files')) e.preventDefault();
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    if (!attach) return;
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    uploads.add(files);
  }

  return (
    <div className="composer" onDragOver={attach ? onDragOver : undefined} onDrop={attach ? onDrop : undefined}>
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
      <div className="composer-input">
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
          onPaste={attach ? onPaste : undefined}
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
      </div>
      {attach && (
        <>
          <button type="button" aria-label="Attach files" onClick={() => fileInput.current?.click()}>
            Attach
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            data-testid="file-input"
            onChange={(e) => {
              uploads.add(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
        </>
      )}
      {attach && uploads.items.length > 0 && (
        <ul className="upload-list">
          {uploads.items.map((it) => (
            <li key={it.key}>
              <span>{it.file.name}</span>{' '}
              {it.status === 'uploading' && (
                <progress aria-label={`Uploading ${it.file.name}`} max={it.file.size} value={it.loaded} />
              )}
              {it.status === 'failed' && (
                <>
                  <span>{it.error}</span>{' '}
                  <button type="button" onClick={() => uploads.retry(it.key)}>
                    Retry
                  </button>
                </>
              )}{' '}
              <button type="button" aria-label={`Remove ${it.file.name}`} onClick={() => uploads.remove(it.key)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {attach && uploads.notice && <p role="alert">{uploads.notice}</p>}
      {pickerOpen && <EmojiPicker label="Insert emoji" trigger={trigger} onPick={insertPicked} onClose={() => setPickerOpen(false)} />}
      {tooLong && <p role="alert">Message is too long (max 40,000 characters).</p>}
    </div>
  );
}
