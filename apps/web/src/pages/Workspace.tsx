import { useEffect, useState } from 'react';
import { api, ApiClientError } from '../api';
import { navigate } from '../nav';
import { Composer } from '../components/Composer';
import { MessageList } from '../components/MessageList';
import { Sidebar } from '../components/Sidebar';
import { TypingIndicator } from '../components/TypingIndicator';
import { channelLabel, notificationPermission, requestNotificationPermission } from '../notifications';
import { useChat } from '../realtime/useChat';

export function Workspace({ slug, channelId }: { slug: string; channelId?: string }) {
  const { state, actions, error } = useChat(slug);
  const [signOutError, setSignOutError] = useState('');
  const [permission, setPermission] = useState(notificationPermission);
  const bootstrap = state.bootstrap;
  const base = `/client/${encodeURIComponent(slug)}`;

  // With no channel in the URL, land on #general (else the first channel).
  useEffect(() => {
    if (channelId || !bootstrap) return;
    const list = Object.values(state.channels);
    const target = list.find((c) => c.kind !== 'dm' && c.name === 'general') ?? list[0];
    if (target) navigate(`${base}/${target.id}`, { replace: true });
  }, [channelId, bootstrap, state.channels, base]);

  useEffect(() => {
    if (channelId) actions.open(channelId);
  }, [channelId, actions]);

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

  async function enableNotifications() {
    setPermission(await requestNotificationPermission());
  }

  if (error) return <p role="alert" className="card">{error}</p>;
  if (!bootstrap) return <p role="status" className="card">Loading…</p>;

  const members = bootstrap.members;
  const me = state.me;
  const myRole = bootstrap.me.role;
  const channel = channelId ? state.channels[channelId] : undefined;
  const label = channel ? channelLabel(channel, members, me) : '';
  const typingIds = channel
    ? [...new Set(state.typing.filter((t) => t.channelId === channel.id && t.parentId === null && t.userId !== me).map((t) => t.userId))]
    : [];

  return (
    <div className="shell">
      <Sidebar
        slug={slug}
        workspaceName={bootstrap.workspace.name}
        channels={Object.values(state.channels)}
        members={members}
        me={me}
        myRole={myRole}
        presence={state.presence}
        activeChannelId={channelId ?? null}
        notificationPermission={permission}
        onOpenChannel={(id) => navigate(`${base}/${id}`)}
        onEnableNotifications={() => void enableNotifications()}
        onAdmin={() => navigate(`${base}/admin`)}
      />
      <div className="main">
        <header>
          <div className="channel-title">
            <strong>{channel ? label : bootstrap.workspace.name}</strong>
            {channel?.topic && <span className="muted topic">{channel.topic}</span>}
          </div>
          <button type="button" onClick={signOut}>
            Sign out
          </button>
          {signOutError && <span role="alert">{signOutError}</span>}
        </header>
        {state.connection === 'reconnecting' && (
          <div role="status" className="banner">
            Reconnecting…
          </div>
        )}
        {channel ? (
          <>
            <MessageList
              key={channel.id}
              channelWindow={state.windows[channel.id]}
              pending={state.pending.filter((p) => p.channelId === channel.id && p.parentId === null)}
              members={members}
              me={me}
              myRole={myRole}
              onLoadOlder={() => void actions.loadOlder(channel.id)}
              onOpenThread={(id) => actions.openThread(id)}
              onEdit={actions.edit}
              onDelete={actions.remove}
              onRetry={actions.retry}
              onDiscard={actions.discard}
            />
            <TypingIndicator userIds={typingIds} members={members} />
            <div className="composer-wrap">
              <Composer
                key={channel.id}
                placeholder={`Message ${label}`}
                members={members}
                onSubmit={(body) => actions.send(channel.id, body)}
                onTyping={() => actions.typing(channel.id)}
              />
            </div>
          </>
        ) : (
          <section className="empty">
            <p>{channelId ? 'This channel isn’t available.' : 'Pick a channel.'}</p>
          </section>
        )}
      </div>
    </div>
  );
}
