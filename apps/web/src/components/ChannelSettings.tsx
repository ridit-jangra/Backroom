import { useId, useState, type FormEvent } from 'react';
import type { ChannelSummary } from '@backroom/protocol';
import { api, ApiClientError } from '../api';
import { Dialog } from './Dialog';

const TAKEN = 'That name is already taken.';
const BAD_NAME = 'Use lowercase letters, numbers, - and _ (max 80).';

export function ChannelSettings({
  channel,
  canManage,
  onClose,
  onGone,
}: {
  channel: ChannelSummary;
  /** Creator or workspace owner/admin. */
  canManage: boolean;
  onClose: () => void;
  /** The caller left or archived the channel; the parent navigates away. */
  onGone: () => void;
}) {
  const isGeneral = channel.kind === 'public' && channel.name === 'general';
  const isDm = channel.kind === 'dm';
  const manage = canManage && !isGeneral && !isDm;
  const [name, setName] = useState(channel.name ?? '');
  const [topic, setTopic] = useState(channel.topic ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const ids = useId();
  const url = `/channels/${encodeURIComponent(channel.id)}`;

  /** `named`: the request changes the name, the only case where 400/409 mean a bad or taken name. */
  async function run(fn: () => Promise<void>, named = false) {
    setError('');
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      if (named && err instanceof ApiClientError && err.status === 409) setError(TAKEN);
      else if (named && err instanceof ApiClientError && err.status === 400) setError(BAD_NAME);
      else setError(err instanceof ApiClientError ? err.message : "Couldn't save changes.");
    } finally {
      setBusy(false);
    }
  }

  function save(e: FormEvent) {
    e.preventDefault();
    const patch: { name?: string; topic?: string } = {};
    const nextName = name.trim().toLowerCase();
    if (manage && nextName !== (channel.name ?? '')) patch.name = nextName;
    if (topic.trim() !== (channel.topic ?? '')) patch.topic = topic.trim();
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    void run(async () => {
      await api(url, { method: 'PATCH', body: patch });
      onClose();
    }, patch.name !== undefined);
  }

  return (
    <Dialog title="Channel settings" onClose={onClose}>
      <form onSubmit={save} className="dialog-form">
        {manage && (
          <>
            <label htmlFor={`${ids}-name`}>Name</label>
            <input id={`${ids}-name`} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
          </>
        )}
        <label htmlFor={`${ids}-topic`}>Topic</label>
        <input id={`${ids}-topic`} value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={250} />
        {error && <p role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="submit" disabled={busy}>
            Save
          </button>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </form>
      {(manage || (!isGeneral && !isDm)) && (
        <div className="dialog-actions danger-zone">
          {!isGeneral && !isDm && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                const label = `#${channel.name ?? ''}`;
                const text =
                  channel.kind === 'private'
                    ? `Leave ${label}? You'll need an invite to rejoin a private channel.`
                    : `Leave ${label}?`;
                if (!globalThis.confirm(text)) return;
                void run(async () => {
                  await api(`${url}/leave`, { method: 'POST', body: {} });
                  onGone();
                });
              }}
            >
              Leave channel
            </button>
          )}
          {manage && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (!globalThis.confirm('Archive this channel?')) return;
                void run(async () => {
                  await api(url, { method: 'PATCH', body: { archived: true } });
                  onGone();
                });
              }}
            >
              Archive channel
            </button>
          )}
        </div>
      )}
    </Dialog>
  );
}
