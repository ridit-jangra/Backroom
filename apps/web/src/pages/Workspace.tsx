import { useEffect, useMemo, useState } from 'react';
import { api, ApiClientError } from '../api';
import { navigate } from '../nav';
import { ChannelBrowser } from '../components/ChannelBrowser';
import { ChannelSettings } from '../components/ChannelSettings';
import { Composer } from '../components/Composer';
import { MessageList } from '../components/MessageList';
import { NewDmDialog } from '../components/NewDmDialog';
import { Sidebar } from '../components/Sidebar';
import { ThreadPanel } from '../components/ThreadPanel';
import { TypingIndicator } from '../components/TypingIndicator';
import { channelLabel, notificationPermission, requestNotificationPermission } from '../notifications';
import { useChat } from '../realtime/useChat';
import { EmojiProvider } from '../emoji/EmojiContext';

export function Workspace({ slug, channelId }: { slug: string; channelId?: string }) {
  const { state, actions, error, threadError } = useChat(slug);
  const [signOutError, setSignOutError] = useState('');
  const [permission, setPermission] = useState(notificationPermission);
  const [dialog, setDialog] = useState<'browse' | 'dm' | 'settings' | null>(null);
  const bootstrap = state.bootstrap;
  const base = `/client/${encodeURIComponent(slug)}`;
  // Stable while the custom set is unchanged, so messages are not re-tokenized on every render.
  const customEmoji = useMemo(() => Object.values(state.customEmoji), [state.customEmoji]);

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

  if (error)
    return (
      <div className="card">
        <p role="alert">{error}</p>
        <button type="button" onClick={() => void actions.refresh()}>
          Try again
        </button>
      </div>
    );
  if (!bootstrap) return <p role="status" className="card">Loading…</p>;

  const members = bootstrap.members;
  const me = state.me;
  const myRole = bootstrap.me.role;
  const channel = channelId ? state.channels[channelId] : undefined;
  const archived = channelId && !channel ? state.archived[channelId] : undefined;
  const label = channel ? channelLabel(channel, members, me) : '';
  const isDm = channel?.kind === 'dm';
  const isGeneral = channel?.kind === 'public' && channel.name === 'general';
  const canManage = !!channel && !isGeneral && (channel.createdBy === me || myRole === 'owner' || myRole === 'admin');
  const threadId = state.openThreadId;
  const threadPage = threadId ? state.threads[threadId] : undefined;
  const threadOpen = !!channel && !!threadId && (!threadPage || threadPage.parent.channelId === channel.id);
  const threadTyping =
    threadId && channel
      ? [...new Set(state.typing.filter((t) => t.channelId === channel.id && t.parentId === threadId && t.userId !== me).map((t) => t.userId))]
      : [];

  /** The channel may be new to this tab (the hub frame can trail the REST reply), so refresh first. */
  async function showChannel(id: string) {
    await actions.refresh();
    setDialog(null);
    navigate(`${base}/${id}`);
  }
  function goGeneral() {
    setDialog(null);
    const general = Object.values(state.channels).find((c) => c.kind === 'public' && c.name === 'general');
    navigate(general ? `${base}/${general.id}` : base);
  }

  const typingIds = channel
    ? [...new Set(state.typing.filter((t) => t.channelId === channel.id && t.parentId === null && t.userId !== me).map((t) => t.userId))]
    : [];

  return (
    <EmojiProvider userId={me} custom={customEmoji}>
      <div className={`shell${threadOpen ? ' has-thread' : ''}`}>
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
          onBrowseChannels={() => setDialog('browse')}
          onNewMessage={() => setDialog('dm')}
          onEnableNotifications={() => void enableNotifications()}
          onAdmin={() => navigate(`${base}/admin`)}
        />
        <div className="main">
          <header>
            <div className="channel-title">
              <strong>{channel ? label : archived ? `#${archived.name ?? ''}` : bootstrap.workspace.name}</strong>
              {archived && <span className="muted topic">Archived</span>}
              {(channel?.topic ?? archived?.topic) && <span className="muted topic">{channel?.topic ?? archived?.topic}</span>}
            </div>
            {channel && !isDm && (
              <button type="button" onClick={() => setDialog('settings')}>
                Channel settings
              </button>
            )}
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
                connected={state.connection === 'open'}
                onLoadOlder={() => void actions.loadOlder(channel.id)}
                onOpenThread={(id) => actions.openThread(id)}
                onEdit={actions.edit}
                onDelete={actions.remove}
                onReact={actions.react}
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
          ) : archived ? (
            <>
              <MessageList
                key={channelId}
                channelWindow={archived.window}
                pending={[]}
                members={members}
                me=""
                myRole="member"
                connected={false}
                onLoadOlder={() => undefined}
                onOpenThread={() => undefined}
                onEdit={() => false}
                onDelete={() => false}
                onRetry={actions.retry}
                onDiscard={actions.discard}
              />
              <section className="empty">
                <p>This channel is archived.</p>
              </section>
            </>
          ) : (
            <section className="empty">
              <p>{channelId ? 'This channel isn’t available.' : 'Pick a channel.'}</p>
            </section>
          )}
        </div>
        {threadOpen && channel && threadId && (
          <ThreadPanel
            key={threadId}
            page={threadPage}
            pending={state.pending.filter((p) => p.channelId === channel.id && p.parentId === threadId)}
            members={members}
            me={me}
            myRole={myRole}
            channelLabel={label}
            isDm={isDm}
            connected={state.connection === 'open'}
            typingUserIds={threadTyping}
            onSend={(body, also) => actions.send(channel.id, body, threadId, also)}
            onTyping={() => actions.typing(channel.id, threadId)}
            onMarkRead={(seq) => actions.markThreadRead(threadId, seq)}
            loadFailed={threadError === threadId}
            onReload={() => actions.openThread(threadId)}
            onEdit={actions.edit}
            onDelete={actions.remove}
            onReact={actions.react}
            onRetry={actions.retry}
            onDiscard={actions.discard}
            onClose={() => actions.openThread(null)}
          />
        )}
        {dialog === 'browse' && <ChannelBrowser slug={slug} onJoined={showChannel} onClose={() => setDialog(null)} />}
        {dialog === 'dm' && (
          <NewDmDialog slug={slug} members={members} me={me} onOpened={showChannel} onClose={() => setDialog(null)} />
        )}
        {dialog === 'settings' && channel && !isDm && (
          <ChannelSettings channel={channel} canManage={canManage} onClose={() => setDialog(null)} onGone={goGeneral} />
        )}
      </div>
    </EmojiProvider>
  );
}
