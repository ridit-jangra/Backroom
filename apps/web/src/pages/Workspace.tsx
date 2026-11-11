import { useEffect, useState } from 'react';
import type { Bootstrap } from '@backroom/protocol';
import { api, ApiClientError } from '../api';
import { navigate } from '../nav';

export function Workspace({ slug }: { slug: string }) {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [error, setError] = useState('');
  const [signOutError, setSignOutError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api<Bootstrap>(`/w/${encodeURIComponent(slug)}/bootstrap`)
      .then((b) => {
        if (!live) return;
        setData(b);
        setSelected((cur) => cur ?? b.channels.find((c) => c.kind === 'public')?.id ?? null);
      })
      .catch((err) => {
        if (!live) return;
        if (err instanceof ApiClientError && err.status === 401) navigate('/login', { replace: true });
        else setError(err instanceof Error ? err.message : 'Something went wrong');
      });
    return () => {
      live = false;
    };
  }, [slug]);

  async function signOut() {
    setSignOutError('');
    try {
      await api('/auth/logout', { method: 'POST', body: {} });
    } catch (err) {
      if (!(err instanceof ApiClientError && err.status === 401)) {
        setSignOutError("Couldn't sign out. Check your connection and try again.");
        return;
      }
    }
    navigate('/login');
  }

  if (error) return <p role="alert" className="card">{error}</p>;
  if (!data) return <p role="status" className="card">Loading…</p>;

  const channel = data.channels.find((c) => c.id === selected);
  return (
    <div className="shell">
      <aside className="sidebar">
        <h2>{data.workspace.name}</h2>
        <nav aria-label="Channels">
          <ul>
            {data.channels.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className={`channel${c.unreadCount > 0 ? ' unread' : ''}${c.id === selected ? ' active' : ''}`}
                  aria-current={c.id === selected ? 'true' : undefined}
                  onClick={() => setSelected(c.id)}
                >
                  #{c.name ?? 'direct message'}
                </button>
                {c.mentionCount > 0 && (
                  <span className="badge" aria-label={`${c.mentionCount} mentions`}>
                    {c.mentionCount}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </nav>
        <h3>Members</h3>
        <ul aria-label="Members">
          {data.members.map((m) => (
            <li key={m.id}>{m.displayName}</li>
          ))}
        </ul>
      </aside>
      <div className="main">
        <header>
          <strong>{channel ? `#${channel.name ?? 'direct message'}` : data.workspace.name}</strong>
          <button type="button" onClick={signOut}>
            Sign out
          </button>
          {signOutError && <span role="alert">{signOutError}</span>}
        </header>
        <section>
          <p>Messages arrive in Phase 2.</p>
        </section>
      </div>
    </div>
  );
}
