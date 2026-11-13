import { useCallback, useEffect, useRef, useState } from 'react';
import type { AdminMember, Bootstrap, CustomEmojiPolicy, InviteSummary } from '@backroom/protocol';
import { api, ApiClientError } from '../api';

const messageOf = (e: unknown) => (e instanceof ApiClientError ? e.message : 'Something went wrong. Try again.');

export function Admin({ slug }: { slug: string }) {
  const base = `/client/${encodeURIComponent(slug)}`;
  const w = `/w/${encodeURIComponent(slug)}`;
  const [me, setMe] = useState<Bootstrap['me'] | null>(null);
  const [invites, setInvites] = useState<InviteSummary[]>([]);
  const [members, setMembers] = useState<AdminMember[]>([]);
  const [policy, setPolicy] = useState<CustomEmojiPolicy>('admins');
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [maxUses, setMaxUses] = useState('50');
  const [days, setDays] = useState('14');
  const [url, setUrl] = useState('');
  /** The invite whose link is on screen, so revoking it also hides the (now dead) link. */
  const [urlInviteId, setUrlInviteId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const urlInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const b = await api<Bootstrap>(`${w}/bootstrap`);
      setMe(b.me);
      setPolicy(b.workspace.settings?.customEmojiPolicy ?? 'admins');
      if (b.me.role === 'member') return;
      const [i, m] = await Promise.all([
        api<{ invites: InviteSummary[] }>(`${w}/invites`),
        api<{ members: AdminMember[] }>(`${w}/members`),
      ]);
      setInvites(i.invites);
      setMembers(m.members);
    } catch (e) {
      setLoadError(messageOf(e));
    }
  }, [w]);
  useEffect(() => void load(), [load]);

  const back = (
    <p>
      <a href={base}>Back to chat</a>
    </p>
  );

  if (loadError)
    return (
      <main className="card">
        <p role="alert">{loadError}</p>
        <button type="button" onClick={() => void load()}>Try again</button>
        {back}
      </main>
    );
  if (!me) return <p role="status" className="card">Loading…</p>;
  if (me.role === 'member')
    return (
      <main className="card">
        <p>You need to be an admin to see this page.</p>
        {back}
      </main>
    );

  async function run(fn: () => Promise<void>) {
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(messageOf(e));
    }
  }

  const create = (ev: React.FormEvent) => {
    ev.preventDefault();
    void run(async () => {
      const r = await api<{ invite: InviteSummary; url: string }>(`${w}/invites`, {
        body: { maxUses: Number(maxUses), expiresInDays: Number(days) },
      });
      setUrl(r.url);
      setUrlInviteId(r.invite.id);
      setCopied(false);
      setInvites((l) => [...l, r.invite]);
    });
  };

  async function copy() {
    setError('');
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Clipboard unavailable: select the text so the user can copy it by hand.
      urlInput.current?.focus();
      urlInput.current?.select();
      setError('Copying is not available here. The link is selected; copy it manually.');
    }
  }

  const revoke = (id: string) => {
    if (!globalThis.confirm('Revoke this invite?')) return;
    return run(async () => {
      await api(`/invites/${id}`, { method: 'DELETE' });
      setInvites((l) => l.filter((i) => i.id !== id));
      if (urlInviteId === id) {
        setUrl('');
        setUrlInviteId(null);
        setCopied(false);
      }
    });
  };

  const changePolicy = (next: CustomEmojiPolicy) => {
    const prev = policy;
    setPolicy(next);
    return run(async () => {
      try {
        await api(`${w}/settings`, { method: 'PATCH', body: { customEmojiPolicy: next } });
      } catch (e) {
        setPolicy(prev);
        throw e;
      }
    });
  };

  const patch = (m: AdminMember, body: { role?: 'admin' | 'member'; deactivated?: boolean }) =>
    run(async () => {
      const r = await api<{ role: AdminMember['role'] }>(`${w}/members/${m.id}`, { method: 'PATCH', body });
      setMembers((l) =>
        l.map((x) =>
          x.id === m.id
            ? { ...x, role: r.role ?? x.role, deactivatedAt: body.deactivated === undefined ? x.deactivatedAt : body.deactivated ? Date.now() : null }
            : x,
        ),
      );
    });

  return (
    <main className="card admin">
      <h1>Admin</h1>
      {back}
      {error && <p role="alert">{error}</p>}

      <h2>Invites</h2>
      <form onSubmit={create}>
        <label>
          Max uses
          <input type="number" min={1} max={500} value={maxUses} onChange={(e) => setMaxUses(e.target.value)} />
        </label>
        <label>
          Expires in days
          <input type="number" min={1} max={90} value={days} onChange={(e) => setDays(e.target.value)} />
        </label>
        <button type="submit">Create invite</button>
      </form>
      {url && (
        <p>
          <input ref={urlInput} readOnly aria-label="Invite link" value={url} onFocus={(e) => e.currentTarget.select()} />
          <button type="button" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy link'}</button>
        </p>
      )}
      <table>
        <thead>
          <tr><th>Uses</th><th>Expires</th><th /></tr>
        </thead>
        <tbody>
          {invites.map((i) => (
            <tr key={i.id}>
              <td>{i.uses}/{i.maxUses}</td>
              <td>{new Date(i.expiresAt).toLocaleDateString()}</td>
              <td><button type="button" className="danger" onClick={() => void revoke(i.id)}>Revoke</button></td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Custom emoji</h2>
      {me.role === 'owner' ? (
        <label>
          Who can add custom emoji
          <select
            aria-label="Who can add custom emoji"
            value={policy}
            onChange={(e) => void changePolicy(e.target.value as CustomEmojiPolicy)}
          >
            <option value="admins">Admins only</option>
            <option value="everyone">Everyone</option>
          </select>
        </label>
      ) : (
        <p>Who can add custom emoji: {policy === 'everyone' ? 'Everyone' : 'Admins only'}</p>
      )}
      <p>
        <a href={`${base}/emoji`}>Manage custom emoji</a>
      </p>

      <h2>Members</h2>
      <table>
        <thead>
          <tr><th>Name</th><th>Role</th><th>Status</th><th /></tr>
        </thead>
        <tbody>
          {members.map((m) => {
            const editable = m.role !== 'owner' && m.id !== me.id;
            return (
              <tr key={m.id}>
                <td>{m.displayName}</td>
                <td>
                  {me.role === 'owner' && m.role !== 'owner' ? (
                    <select
                      aria-label={`Role for ${m.displayName}`}
                      value={m.role}
                      onChange={(e) => void patch(m, { role: e.target.value as 'admin' | 'member' })}
                    >
                      <option value="admin">admin</option>
                      <option value="member">member</option>
                    </select>
                  ) : (
                    m.role
                  )}
                </td>
                <td>{m.deactivatedAt === null ? 'Active' : 'Deactivated'}</td>
                <td>
                  {editable && (
                    <button type="button" className={m.deactivatedAt === null ? 'danger' : undefined} onClick={() => void patch(m, { deactivated: m.deactivatedAt === null })}>
                      {m.deactivatedAt === null ? 'Deactivate' : 'Reactivate'}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </main>
  );
}
