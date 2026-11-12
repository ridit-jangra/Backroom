import { useEffect, useId, useState, type FormEvent } from 'react';
import type { ChannelListing } from '@backroom/protocol';
import { api, ApiClientError } from '../api';
import { Dialog } from './Dialog';

const TAKEN = 'That name is already taken.';
const BAD_NAME = 'Use lowercase letters, numbers, - and _ (max 80).';

export function ChannelBrowser({
  slug,
  onJoined,
  onClose,
}: {
  slug: string;
  /** Called with the channel to show, after joining, opening or creating it. */
  onJoined: (channelId: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const [channels, setChannels] = useState<ChannelListing[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [joinError, setJoinError] = useState('');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [createError, setCreateError] = useState('');
  const ids = useId();

  useEffect(() => {
    let live = true;
    api<{ channels: ChannelListing[] }>(`/w/${encodeURIComponent(slug)}/channels`).then(
      (r) => live && setChannels(r.channels),
      (e) => live && setLoadError(e instanceof Error ? e.message : 'Could not load channels.'),
    );
    return () => {
      live = false;
    };
  }, [slug]);

  async function join(c: ChannelListing) {
    setJoinError('');
    if (c.isMember) {
      await onJoined(c.id);
      return;
    }
    setBusy(true);
    try {
      await api(`/channels/${encodeURIComponent(c.id)}/join`, { method: 'POST', body: {} });
      await onJoined(c.id);
    } catch (e) {
      setJoinError(e instanceof Error ? e.message : 'Could not join.');
    } finally {
      setBusy(false);
    }
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    setCreateError('');
    setBusy(true);
    try {
      const body: { name: string; private: boolean; topic?: string } = {
        name: name.trim().toLowerCase(),
        private: isPrivate,
      };
      if (topic.trim()) body.topic = topic.trim();
      const r = await api<{ channel: { id: string } }>(`/w/${encodeURIComponent(slug)}/channels`, { method: 'POST', body });
      await onJoined(r.channel.id);
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 409) setCreateError(TAKEN);
      else if (err instanceof ApiClientError && err.status === 400) setCreateError(BAD_NAME);
      else setCreateError(err instanceof Error ? err.message : 'Could not create the channel.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="Browse channels" onClose={onClose}>
      {loadError && <p role="alert">{loadError}</p>}
      {!channels && !loadError && <p role="status" className="muted">Loading…</p>}
      {channels && (
        <ul className="browse-list" aria-label="Channels">
          {channels.map((c) => (
            <li key={c.id}>
              <div>
                <strong>#{c.name}</strong>{' '}
                <span className="muted">{c.memberCount === 1 ? '1 member' : `${c.memberCount} members`}</span>
                {c.topic && <div className="muted">{c.topic}</div>}
              </div>
              <button type="button" disabled={busy} onClick={() => void join(c)}>
                {c.isMember ? 'Open' : 'Join'}
              </button>
            </li>
          ))}
        </ul>
      )}
      {joinError && <p role="alert">{joinError}</p>}
      <form onSubmit={(e) => void create(e)} className="dialog-form" aria-label="Create channel">
        <h3>Create channel</h3>
        <label htmlFor={`${ids}-name`}>Name</label>
        <input id={`${ids}-name`} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
        <label htmlFor={`${ids}-topic`}>Topic</label>
        <input id={`${ids}-topic`} value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={250} />
        <label className="check">
          <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} /> Private
        </label>
        {createError && <p role="alert">{createError}</p>}
        <div className="dialog-actions">
          <button type="submit" disabled={busy || name.trim() === ''}>
            Create
          </button>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </form>
    </Dialog>
  );
}
