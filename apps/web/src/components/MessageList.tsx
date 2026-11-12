import { useLayoutEffect, useRef, useState } from 'react';
import type { MemberSummary, Message, Role } from '@backroom/protocol';
import type { PendingSend } from '../realtime/outbox';
import type { ChannelWindow } from '../state/chat';
import { parseReactionCode } from '@backroom/emoji';
import { useEmoji } from '../emoji/EmojiContext';
import { EmojiPicker } from '../emoji/EmojiPicker';
import { ReactionBar } from '../emoji/ReactionBar';
import { Composer } from './Composer';
import { MessageText } from './MessageText';

export const GROUP_WINDOW_MS = 300_000;
const BOTTOM_SLACK_PX = 40;

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function nameOf(members: MemberSummary[], id: string): string {
  return members.find((m) => m.id === id)?.displayName ?? 'Unknown';
}

/** True when `m` starts a new author group after `prev`. */
export function startsGroup(prev: Pick<Message, 'userId' | 'createdAt'> | undefined, m: Pick<Message, 'userId' | 'createdAt'>): boolean {
  return !prev || prev.userId !== m.userId || m.createdAt - prev.createdAt >= GROUP_WINDOW_MS;
}

export function MessageRow({
  message,
  members,
  me,
  myRole,
  showHeader,
  connected,
  onOpenThread,
  onEdit,
  onDelete,
  onReact,
}: {
  message: Message;
  members: MemberSummary[];
  me: string;
  myRole: Role;
  showHeader: boolean;
  /** Edits and deletes need the socket; while it is down the controls are disabled. */
  connected: boolean;
  onOpenThread?: (messageId: string) => void;
  /** Returns false when the edit could not be sent. */
  onEdit: (messageId: string, body: string) => boolean;
  onDelete: (messageId: string) => boolean;
  /** Returns false when the reaction could not be sent. */
  onReact?: (messageId: string, emoji: string, on: boolean) => boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);
  const emoji = useEmoji();
  const [sendError, setSendError] = useState(false);
  const offlineTitle = connected ? undefined : 'Reconnecting…';
  const deleted = message.deletedAt !== null;
  const own = message.userId === me;
  const canEdit = own && !deleted;
  const canDelete = !deleted && (own || myRole === 'owner' || myRole === 'admin');
  const replies = message.replyCount;
  const reactions = message.reactions ?? [];
  const canReact = !!onReact && !deleted;

  // P3-R9: compare against the canonical code, so an alias pick toggles the reaction it names.
  function react(emojiCode: string, on: boolean) {
    setSendError(!onReact!(message.id, emojiCode, on));
  }
  function pickReaction(code: string) {
    setPickerOpen(false);
    const p = parseReactionCode(code);
    const canon = p ? emoji.canonical(p.name, p.tone) : null;
    if (canon === null) return react(code, true);
    const mine = reactions.find((r) => r.emoji === canon)?.userIds.includes(me) ?? false;
    react(canon, !mine);
  }

  return (
    <li className={`msg${showHeader ? ' msg-first' : ''}`}>
      {showHeader && (
        <div className="msg-head">
          <strong className="msg-author">{nameOf(members, message.userId)}</strong>{' '}
          <time className="muted" dateTime={new Date(message.createdAt).toISOString()}>
            {formatTime(message.createdAt)}
          </time>
        </div>
      )}
      {deleted ? (
        <p className="msg-body muted">
          <em>This message was deleted.</em>
        </p>
      ) : editing ? (
        <Composer
          placeholder="Edit message"
          members={members}
          initial={message.body}
          onSubmit={(body) => {
            if (body !== message.body && !onEdit(message.id, body)) {
              setSendError(true);
              return false;
            }
            setSendError(false);
            setEditing(false);
          }}
          onCancel={() => {
            setSendError(false);
            setEditing(false);
          }}
        />
      ) : (
        <p className="msg-body">
          <MessageText body={message.body} members={members} me={me} />
          {message.editedAt !== null && <span className="muted"> (edited)</span>}
        </p>
      )}
      {canReact && (
        <ReactionBar reactions={reactions} me={me} members={members} connected={connected} onToggle={(e, on) => onReact!(message.id, e, on)} />
      )}
      {replies > 0 && onOpenThread && (
        <button type="button" className="link replies" onClick={() => onOpenThread(message.id)}>
          {replies === 1 ? '1 reply' : `${replies} replies`}
        </button>
      )}
      {sendError && <p role="alert" className="msg-error">Not connected — try again.</p>}
      {(canEdit || canDelete || canReact) && !editing && (
        <div className="msg-actions">
          {canReact && (
            <span className="reaction-add">
              <button
                ref={addRef}
                type="button"
                className="link"
                aria-label="Add reaction"
                aria-haspopup="dialog"
                aria-expanded={pickerOpen}
                data-emoji-trigger
                disabled={!connected}
                title={offlineTitle}
                onClick={() => setPickerOpen((o) => !o)}
              >
                ☺+
              </button>
              {pickerOpen && connected && (
                <EmojiPicker label="Add reaction" trigger={addRef} onPick={pickReaction} onClose={() => setPickerOpen(false)} />
              )}
            </span>
          )}
          {canEdit && (
            <button type="button" className="link" disabled={!connected} title={offlineTitle} onClick={() => setEditing(true)}>
              Edit
            </button>
          )}
          {canDelete && (
            <button
              type="button"
              className="link"
              disabled={!connected}
              title={offlineTitle}
              onClick={() => {
                if (globalThis.confirm('Delete this message?')) setSendError(!onDelete(message.id));
              }}
            >
              Delete
            </button>
          )}
        </div>
      )}
    </li>
  );
}

export function PendingRow({
  p,
  members,
  me,
  showHeader,
  onRetry,
  onDiscard,
}: {
  p: PendingSend;
  members: MemberSummary[];
  me: string;
  showHeader: boolean;
  onRetry: (clientId: string) => void;
  onDiscard: (clientId: string) => void;
}) {
  return (
    <li className={`msg pending${p.status === 'failed' ? ' failed' : ''}${showHeader ? ' msg-first' : ''}`}>
      {showHeader && (
        <div className="msg-head">
          <strong className="msg-author">{nameOf(members, me)}</strong>
        </div>
      )}
      <p className="msg-body">
        <MessageText body={p.body} members={members} me={me} />
      </p>
      {p.status === 'sending' ? (
        <span className="muted">Sending…</span>
      ) : (
        <div className="msg-actions">
          <span role="alert">Failed to send</span>{' '}
          <button type="button" className="link" onClick={() => onRetry(p.clientId)}>
            Retry
          </button>
          <button type="button" className="link" onClick={() => onDiscard(p.clientId)}>
            Discard
          </button>
        </div>
      )}
    </li>
  );
}

export function MessageList({
  channelWindow,
  pending,
  members,
  me,
  myRole,
  connected,
  onLoadOlder,
  onOpenThread,
  onEdit,
  onDelete,
  onReact,
  onRetry,
  onDiscard,
}: {
  channelWindow: ChannelWindow | undefined;
  pending: PendingSend[];
  members: MemberSummary[];
  me: string;
  myRole: Role;
  connected: boolean;
  onLoadOlder: () => void;
  onOpenThread: (messageId: string) => void;
  onEdit: (messageId: string, body: string) => boolean;
  onDelete: (messageId: string) => boolean;
  onReact?: (messageId: string, emoji: string, on: boolean) => boolean;
  onRetry: (clientId: string) => void;
  onDiscard: (clientId: string) => void;
}) {
  const messages = channelWindow?.messages ?? [];
  const box = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const prevFirst = useRef<string | undefined>(undefined);
  const prevHeight = useRef(0);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const first = messages[0]?.id;
    if (prevFirst.current !== undefined && first !== prevFirst.current && !atBottom.current) {
      // Older messages were prepended: keep what the reader was looking at in place.
      el.scrollTop += el.scrollHeight - prevHeight.current;
    } else if (atBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
    prevFirst.current = first;
    prevHeight.current = el.scrollHeight;
  }, [messages, pending]);

  const last = messages[messages.length - 1];
  return (
    <div
      ref={box}
      className="messages"
      role="log"
      aria-label="Messages"
      onScroll={(e) => {
        const el = e.currentTarget;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK_PX;
        prevHeight.current = el.scrollHeight;
      }}
    >
      {channelWindow?.hasOlder && (
        <button type="button" className="load-older" onClick={onLoadOlder}>
          Load older messages
        </button>
      )}
      {channelWindow && !channelWindow.loaded && <p className="muted">Loading…</p>}
      <ul className="msg-list">
        {messages.map((m, i) => (
          <MessageRow
            key={m.id}
            message={m}
            members={members}
            me={me}
            myRole={myRole}
            showHeader={startsGroup(messages[i - 1], m)}
            connected={connected}
            onOpenThread={onOpenThread}
            onEdit={onEdit}
            onDelete={onDelete}
            onReact={onReact}
          />
        ))}
        {pending.map((p, i) => (
          <PendingRow
            key={p.clientId}
            p={p}
            members={members}
            me={me}
            showHeader={i === 0 && (!last || last.userId !== me)}
            onRetry={onRetry}
            onDiscard={onDiscard}
          />
        ))}
      </ul>
    </div>
  );
}
