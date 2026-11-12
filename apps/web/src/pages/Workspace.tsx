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
import { desktopSetBadge, isDesktop, onDesktopNavigate } from '../desktop/bridge';
import { channelLabel, notificationPermission, requestNotificationPermission } from '../notifications';
import { useChat } from '../realtime/useChat';
import { EmojiProvider } from '../emoji/EmojiContext';
import { SearchPanel } from '../search/SearchPanel';
import type { SearchHit } from '@backroom/protocol';

export function Workspace({ slug, channelId }: { slug: string; channelId?: string }) {
  const { state, actions, error, threadError } = useChat(slug);
  const [signOutError, setSignOutError] = useState('');
  const [permission, setPermission] = useState(() => (isDesktop() ? 'unsupported' : notificationPermission()));
  const [searchQuery, setSearchQuery] = useState('');
  const [searchDraft, setSearchDraft] = useState('');
  const [jumpError, setJumpError] = useState('');
  const [dialog, setDialog] = useState<'browse' | 'dm' | 'settings' | null>(null);
  const bootstrap = state.bootstrap;
  const base = `/client/${encodeURIComponent(slug)}`;
  // Stable while the custom set is unchanged, so messages are not re-tokenized on every render.
  const customEmoji = useMemo(() => Object.values(state.customEmoji), [state.customEmoji]);

  useEffect(() => setJumpError(''), [channelId]);

  // Desktop shell: dock/taskbar badge = unread across the channels I belong to.
  const totalUnread = Object.values(state.channels).reduce((n, c) => n + c.unreadCount, 0);
  useEffect(() => {
    if (state.bootstrap) void desktopSetBadge(totalUnread);
  }, [totalUnread, state.bootstrap]);

  // A clicked desktop notification asks to open its channel.
  useEffect(() => onDesktopNavigate((id) => navigate(`/client/${encodeURIComponent(slug)}/${encodeURIComponent(id)}`)), [slug]);

  // With no channel in the URL, land on #general (else the first channel).
  useEffect(() => {
    if (channelId || !bootstrap) return;
    const list = Object.values(state.channels);
    const target = list.find((c) => c.kind !== 'dm' && c.name === 'general') ?? list[0];
    if (target) navigate(`${base}/${target.id}`, { replace: true });
  }, [channelId, bootstrap, state.channels, base]);

  useEffect(() => {
    // P4-R9: jumpTo may already have opened this channel; opening again would clear the highlight.
    if (channelId && state.openChannelId !== channelId) actions.open(channelId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  async function onJump(hit: SearchHit) {
    setJumpError('');
    // A just-joined channel is new to this tab, so refresh before opening it.
    if (!hit.channel.isMember) await actions.refresh();
    navigate(`${base}/${hit.channel.id}`);
    const m = hit.message;
    const ok = await actions.jumpTo({
      channelId: hit.channel.id,
      messageId: m.id,
      seq: m.seq,
      parentId: m.parentId,
      alsoInChannel: m.alsoInChannel,
    });
    if (!ok) setJumpError('That message is too far back to show here.');
  }
  function submitSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = searchDraft.trim();
    if (!q) return;
    setJumpError('');
    actions.openThread(null);
    setSearchQuery(q);
  }
  // One side panel at a time: an open thread replaces the results (the query is kept, so closing the thread brings them back).
  const searchOpen = !!searchQuery && !threadOpen;

  const typingIds = channel
    ? [...new Set(state.typing.filter((t) => t.channelId === channel.id && t.parentId === null && t.userId !== me).map((t) => t.userId))]
    : [];

  return (
    <EmojiProvider userId={me} custom={customEmoji}>
      <div className={`shell${threadOpen || searchOpen ? ' has-thread' : ''}`}>
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
            <form role="search" onSubmit={submitSearch}>
              <input
                type="search"
                aria-label="Search messages"
                placeholder="Search"
                maxLength={256}
                value={searchDraft}
                onChange={(e) => setSearchDraft(e.target.value)}
              />
            </form>
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
          {jumpError && <p role="alert" className="banner">{jumpError}</p>}
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
                highlightId={state.highlightId}
                highlightNonce={state.highlightNonce}
              />
              <TypingIndicator userIds={typingIds} members={members} />
              <div className="composer-wrap">
                <Composer
                  key={channel.id}
                  placeholder={`Message ${label}`}
                  members={members}
                  uploadSlug={slug}
                  onSubmit={(body, files) => actions.send(channel.id, body, null, false, files)}
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
            uploadSlug={slug}
            onSend={(body, also, files) => actions.send(channel.id, body, threadId, also, files)}
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
            highlightId={state.highlightId}
            highlightNonce={state.highlightNonce}
          />
        )}
        {searchOpen && (
          <SearchPanel
            slug={slug}
            query={searchQuery}
            members={members}
            onJump={onJump}
            onClose={() => {
              setJumpError('');
              setSearchQuery('');
            }}
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
