import type { ChannelSummary, MemberSummary, PresenceState, Role } from '@backroom/protocol';
import { channelLabel } from '../notifications';

/** Badge text: the server caps counts at 100 (P2-R27), so anything above 99 shows as "99+". */
export function badgeCount(n: number): string {
  return n > 99 ? '99+' : String(n);
}

function ChannelItem({
  c,
  label,
  active,
  onOpen,
}: {
  c: ChannelSummary;
  label: string;
  active: boolean;
  onOpen: (id: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        className={`channel${c.unreadCount > 0 ? ' unread' : ''}${active ? ' active' : ''}`}
        aria-current={active ? 'true' : undefined}
        onClick={() => onOpen(c.id)}
      >
        {label}
      </button>
      {c.mentionCount > 0 && (
        <span className="badge" aria-label={`${badgeCount(c.mentionCount)} mentions`}>
          {badgeCount(c.mentionCount)}
        </span>
      )}
    </li>
  );
}

export function Sidebar({
  slug,
  workspaceName,
  channels,
  members,
  me,
  myRole,
  presence,
  activeChannelId,
  notificationPermission,
  onOpenChannel,
  onBrowseChannels,
  onNewMessage,
  onEnableNotifications,
  onAdmin,
}: {
  slug: string;
  workspaceName: string;
  channels: ChannelSummary[];
  members: MemberSummary[];
  me: string;
  myRole: Role;
  presence: Record<string, PresenceState>;
  activeChannelId: string | null;
  notificationPermission: NotificationPermission | 'unsupported';
  onOpenChannel: (id: string) => void;
  onBrowseChannels?: () => void;
  onNewMessage?: () => void;
  onEnableNotifications: () => void;
  onAdmin: () => void;
}) {
  const named = channels
    .filter((c) => c.kind !== 'dm')
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  const dms = channels
    .filter((c) => c.kind === 'dm')
    .map((c) => ({ c, label: channelLabel(c, members, me) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const isAdmin = myRole === 'owner' || myRole === 'admin';
  const adminHref = `/client/${encodeURIComponent(slug)}/admin`;

  return (
    <aside className="sidebar">
      <h2>{workspaceName}</h2>
      <div className="sidebar-actions">
        <button type="button" onClick={onBrowseChannels} disabled={!onBrowseChannels}>
          Browse channels
        </button>
        <button type="button" onClick={onNewMessage} disabled={!onNewMessage}>
          New message
        </button>
        {isAdmin && (
          <a
            href={adminHref}
            className="button-link"
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              onAdmin();
            }}
          >
            Admin
          </a>
        )}
        {notificationPermission === 'default' && (
          <button type="button" onClick={onEnableNotifications}>
            Enable notifications
          </button>
        )}
      </div>
      <h3>Channels</h3>
      <nav aria-label="Channels">
        <ul>
          {named.map((c) => (
            <ChannelItem key={c.id} c={c} label={channelLabel(c, members, me)} active={c.id === activeChannelId} onOpen={onOpenChannel} />
          ))}
        </ul>
      </nav>
      {dms.length > 0 && (
        <>
          <h3>Direct messages</h3>
          <nav aria-label="Direct messages">
            <ul>
              {dms.map(({ c, label }) => (
                <ChannelItem key={c.id} c={c} label={label} active={c.id === activeChannelId} onOpen={onOpenChannel} />
              ))}
            </ul>
          </nav>
        </>
      )}
      <h3>Members</h3>
      <ul aria-label="Members">
        {members.filter((m) => !m.deactivated).map((m) => {
          const st = presence[m.id] ?? 'away';
          return (
            <li key={m.id} className="member">
              <span className={`dot ${st}`} role="img" aria-label={st} />
              <span className="member-name">{m.displayName}</span>
              {m.id === me && <span className="muted"> (you)</span>}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
