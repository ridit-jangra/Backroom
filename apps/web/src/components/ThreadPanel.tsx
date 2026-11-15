import { useEffect, useId, useRef, useState } from 'react';
import type { FileInfo, MemberSummary, Role, ThreadPage } from '@backroom/protocol';
import type { PendingSend } from '../realtime/outbox';
import { liveMessages } from '../state/chat';
import { Composer } from './Composer';
import { MessageRow, PendingRow, startsGroup } from './MessageList';
import { TypingIndicator } from './TypingIndicator';

/** Presentational: the parent owns fetching (`openThread`) and every action. */
export function ThreadPanel({
  page,
  pending,
  members,
  me,
  myRole,
  channelLabel,
  isDm,
  connected,
  typingUserIds,
  onSend,
  uploadSlug,
  onTyping,
  onMarkRead,
  onEdit,
  onDelete,
  onReact,
  onRetry,
  onDiscard,
  loadFailed = false,
  onReload,
  onClose,
  highlightId = null,
  highlightNonce = 0,
}: {
  /** Undefined while the thread is still loading. */
  page: ThreadPage | undefined;
  pending: PendingSend[];
  members: MemberSummary[];
  me: string;
  myRole: Role;
  channelLabel: string;
  isDm: boolean;
  connected: boolean;
  typingUserIds: string[];
  onSend: (body: string, alsoInChannel: boolean, files: FileInfo[]) => boolean | void;
  uploadSlug?: string;
  onTyping?: () => void;
  /** Returns false when the frame could not be sent. */
  onMarkRead: (seq: number) => boolean;
  onEdit: (messageId: string, body: string) => boolean;
  onDelete: (messageId: string) => boolean;
  onReact?: (messageId: string, emoji: string, on: boolean) => boolean;
  onRetry: (clientId: string) => void;
  onDiscard: (clientId: string) => void;
  /** The thread fetch failed. */
  loadFailed?: boolean;
  onReload?: () => void;
  onClose: () => void;
  highlightId?: string | null;
  highlightNonce?: number;
}) {
  const [also, setAlso] = useState(false);
  const alsoId = useId();
  const replies = liveMessages(page?.replies ?? []);
  // Live-only is safe: the server's unread math ignores deleted replies and thread read pointers
  // only move forward (`last_read_reply_seq < ?`), so a lower seq than a deleted reply's is harmless.
  const lastSeq = replies.reduce((a, m) => Math.max(a, m.seq), 0);
  const marked = useRef(0);
  const parentId = page?.parent.id;

  // The thread is on screen, so replies that arrive while it is open count as read.
  useEffect(() => {
    marked.current = 0;
  }, [parentId]);
  // `marked` only advances when the frame was sent, so a send that failed offline goes out after reconnect.
  useEffect(() => {
    if (connected && lastSeq > marked.current && onMarkRead(lastSeq)) marked.current = lastSeq;
  }, [lastSeq, connected, onMarkRead]);

  const lastReply = replies[replies.length - 1];
  return (
    <aside className="thread" aria-label="Thread" tabIndex={-1}>
      <div className="thread-head">
        <strong>Thread</strong>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
      {!page && loadFailed ? (
        <div className="thread-loading">
          <p role="alert">Couldn't load this thread.</p>
          <button type="button" onClick={onReload}>
            Retry
          </button>
        </div>
      ) : !page ? (
        <p role="status" className="muted thread-loading">
          Loading…
        </p>
      ) : (
        <div className="thread-body">
          <ul className="msg-list thread-parent">
            <MessageRow
              message={page.parent}
              members={members}
              me={me}
              myRole={myRole}
              showHeader
              connected={connected}
              onEdit={onEdit}
              onDelete={onDelete}
              onReact={onReact}
              highlighted={page.parent.id === highlightId}
              highlightNonce={highlightNonce}
            />
          </ul>
          {replies.length > 0 && (
            <p className="muted thread-count">{replies.length === 1 ? '1 reply' : `${replies.length} replies`}</p>
          )}
          <ul className="msg-list" aria-label="Replies">
            {replies.map((m, i) => (
              <MessageRow
                key={m.id}
                message={m}
                members={members}
                me={me}
                myRole={myRole}
                showHeader={startsGroup(replies[i - 1], m)}
                connected={connected}
                onEdit={onEdit}
                onDelete={onDelete}
                onReact={onReact}
                highlighted={m.id === highlightId}
                highlightNonce={highlightNonce}
              />
            ))}
            {pending.map((p, i) => (
              <PendingRow
                key={p.clientId}
                p={p}
                members={members}
                me={me}
                showHeader={i === 0 && (!lastReply || lastReply.userId !== me)}
                onRetry={onRetry}
                onDiscard={onDiscard}
              />
            ))}
          </ul>
        </div>
      )}
      <TypingIndicator userIds={typingUserIds} members={members} />
      {page && (
        <div className="composer-wrap">
          <Composer
            placeholder="Reply…"
            members={members}
            uploadSlug={uploadSlug}
            onSubmit={(body, files) => {
              const sent = onSend(body, also, files);
              if (sent !== false) setAlso(false);
              return sent;
            }}
            onTyping={onTyping}
          />
          <label htmlFor={alsoId} className="also">
            <input id={alsoId} type="checkbox" checked={also} onChange={(e) => setAlso(e.target.checked)} />
            Also send to {isDm ? 'conversation' : channelLabel}
          </label>
        </div>
      )}
    </aside>
  );
}
