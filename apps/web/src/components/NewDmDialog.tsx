import { useState } from 'react';
import type { MemberSummary } from '@backroom/protocol';
import { api } from '../api';
import { Dialog } from './Dialog';

const MAX_OTHERS = 8;

export function NewDmDialog({
  slug,
  members,
  me,
  onOpened,
  onClose,
}: {
  slug: string;
  members: MemberSummary[];
  me: string;
  onOpened: (channelId: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const others = members.filter((m) => m.id !== me);
  const full = picked.length >= MAX_OTHERS;

  async function open() {
    setError('');
    setBusy(true);
    let opened: { channel: { id: string } };
    try {
      opened = await api<{ channel: { id: string } }>(`/w/${encodeURIComponent(slug)}/dms`, {
        method: 'POST',
        body: { userIds: picked },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open the conversation.');
      setBusy(false);
      return;
    }
    try {
      await onOpened(opened.channel.id);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="New message" onClose={onClose}>
      <fieldset className="dm-pick">
        <legend>People</legend>
        {others.map((m) => (
          <label key={m.id} className="check">
            <input
              type="checkbox"
              checked={picked.includes(m.id)}
              disabled={!picked.includes(m.id) && full}
              onChange={(e) => setPicked((p) => (e.target.checked ? [...p, m.id] : p.filter((x) => x !== m.id)))}
            />{' '}
            {m.displayName}
          </label>
        ))}
      </fieldset>
      {full && <p className="muted">You can add up to {MAX_OTHERS} people.</p>}
      {error && <p role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" disabled={busy || picked.length === 0} onClick={() => void open()}>
          Open
        </button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Dialog>
  );
}
