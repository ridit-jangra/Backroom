import type { MemberSummary } from '@backroom/protocol';
import { tokenize } from '../text/tokenize';

export function MessageText({ body, members, me }: { body: string; members: MemberSummary[]; me: string }) {
  const names = new Map(members.map((m) => [m.id, m.displayName]));
  return (
    <span className="msg-text">
      {tokenize(body).map((t, i) => {
        switch (t.kind) {
          case 'text':
            return t.text;
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
        }
      })}
    </span>
  );
}
