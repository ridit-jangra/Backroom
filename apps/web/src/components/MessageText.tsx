import type { MemberSummary } from '@backroom/protocol';
import { useMemo } from 'react';
import { isEmojiOnly, tokenize } from '../text/tokenize';
import { useEmoji } from '../emoji/EmojiContext';
import { EmojiImg } from '../emoji/EmojiImg';

export function MessageText({ body, members, me }: { body: string; members: MemberSummary[]; me: string }) {
  const names = new Map(members.map((m) => [m.id, m.displayName]));
  const { isKnown, resolve } = useEmoji();
  const tokens = useMemo(() => tokenize(body, isKnown), [body, isKnown]);
  return (
    <span className={isEmojiOnly(tokens) ? 'msg-text jumbo' : 'msg-text'}>
      {tokens.map((t, i) => {
        switch (t.kind) {
          case 'text':
            // The pre is already a block; its trailing newline would add a blank line.
            return tokens[i - 1]?.kind === 'codeblock' ? t.text.replace(/^\r?\n/, '') : t.text;
          case 'code':
            return <code key={i}>{t.text}</code>;
          case 'codeblock':
            return (
              <pre key={i}>
                <code>{t.text}</code>
              </pre>
            );
          case 'link':
            return (
              <a key={i} href={t.href} target="_blank" rel="noopener noreferrer nofollow">
                {t.text}
              </a>
            );
          case 'user':
            return (
              <span key={i} className={t.userId === me ? 'mention me' : 'mention'}>
                @{names.get(t.userId) ?? 'unknown'}
              </span>
            );
          case 'broadcast':
            return (
              <span key={i} className="mention">
                @{t.which}
              </span>
            );
          case 'emoji': {
            // Resolved again at render: a custom emoji deleted since tokenizing falls back to text.
            const e = resolve(t.name, t.tone);
            return e ? <EmojiImg key={i} e={e} /> : t.text;
          }
        }
      })}
    </span>
  );
}
