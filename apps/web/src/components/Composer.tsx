import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { MAX_BODY, TYPING_THROTTLE_MS, type MemberSummary } from '@backroom/protocol';
import { decodeMentions, encodeMentions } from '../text/tokenize';

const MENTION_QUERY_RE = /(?:^|\s)@([^\s@]*)$/;
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
  onSubmit: (body: string) => void;
  onTyping?: () => void;
  onCancel?: () => void;
}) {
  const init = useMemo(() => decodeMentions(initial ?? '', members), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [text, setText] = useState(init.text);
  const picked = useRef<Map<string, string>>(init.picked);
  const lastTyping = useRef<number | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(init.text.length);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  const encoded = encodeMentions(text, picked.current);
  const tooLong = encoded.length > MAX_BODY;

  const query = MENTION_QUERY_RE.exec(text.slice(0, caret))?.[1];
  const matches = useMemo(() => {
    if (query === undefined || dismissed) return [];
    const q = query.toLowerCase();
    return members.filter((m) => m.displayName.toLowerCase().startsWith(q)).slice(0, MAX_SUGGESTIONS);
  }, [query, members, dismissed]);
  const open = matches.length > 0;

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
    if (encoded.trim() === '' || tooLong) return;
    onSubmit(encoded);
    setText('');
    setCaret(0);
    picked.current = new Map();
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
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
      {open && (
        <ul role="listbox" aria-label="Mention suggestions" className="mention-list">
          {matches.map((m, i) => (
            <li
              key={m.id}
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
      {tooLong && <p role="alert">Message is too long (max 40,000 characters).</p>}
    </div>
  );
}
