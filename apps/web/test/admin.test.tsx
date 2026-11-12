import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AdminMember, InviteSummary } from '@backroom/protocol';
import { App } from '../src/App';
import { ANN, BOB, ME, err, makeBootstrap, stubApi } from './harness';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  history.replaceState(null, '', '/');
});

const inv = (n: string, o: Partial<InviteSummary> = {}): InviteSummary => ({ id: n.padEnd(26, '0'), maxUses: 50, uses: 2, expiresAt: Date.UTC(2030, 0, 15, 12), createdBy: ME, ...o });
const members = (): AdminMember[] => [
  { id: ANN, displayName: 'Ann', role: 'owner', avatarKey: null, deactivatedAt: null },
  { id: ME, displayName: 'Me', role: 'admin', avatarKey: null, deactivatedAt: null },
  { id: BOB, displayName: 'Bob', role: 'member', avatarKey: null, deactivatedAt: null },
];

function open(role: 'member' | 'admin' | 'owner', invites: InviteSummary[] = []) {
  const bootstrap = makeBootstrap({}, role as 'admin');
  const posted = stubApi({
    bootstrap: () => bootstrap,
    route: (url, init) => {
      if (url === '/w/clubhack/invites' && (init?.method ?? 'GET') === 'GET') return { invites };
      if (url === '/w/clubhack/invites' && init?.method === 'POST') return new Response(JSON.stringify({ invite: inv('01JNEW'), url: 'https://app.test/invite/secret' }), { status: 201 });
      if (url === '/w/clubhack/members' && (init?.method ?? 'GET') === 'GET') return { members: members().map((m) => (m.id === ME ? { ...m, role } : m)) };
      if (url.startsWith('/invites/')) return { ok: true };
      const p = /^\/w\/clubhack\/members\/(\w+)$/.exec(url);
      if (p && init?.method === 'PATCH') {
        const body = JSON.parse(init.body!);
        return { id: p[1], displayName: 'Bob', role: body.role ?? 'member', avatarKey: null };
      }
      return undefined;
    },
  });
  history.replaceState(null, '', '/client/clubhack/admin');
  render(<App />);
  return posted;
}

describe('Admin page', () => {
  it('create invite shows the link and copies it', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const posted = open('admin');
    await userEvent.click(await screen.findByRole('button', { name: 'Create invite' }));
    const input = (await screen.findByLabelText('Invite link')) as HTMLInputElement;
    expect(input.value).toBe('https://app.test/invite/secret');
    expect(input.readOnly).toBe(true);
    expect(posted[0]).toMatchObject({ url: '/w/clubhack/invites', body: { maxUses: 50, expiresInDays: 14 } });
    await userEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(writeText).toHaveBeenCalledWith('https://app.test/invite/secret');
    await screen.findByRole('button', { name: 'Copied' });
  });

  it('copy falls back to selecting the text when the clipboard is unavailable', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    open('admin');
    await userEvent.click(await screen.findByRole('button', { name: 'Create invite' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Copy link' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/selected/);
    expect(document.activeElement).toBe(screen.getByLabelText('Invite link'));
  });

  it('revoke removes the invite row', async () => {
    const posted = open('admin', [inv('01JA'), inv('01JB', { uses: 7 })]);
    expect(await screen.findByText('7/50')).toBeTruthy();
    const row = screen.getByText('7/50').closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(screen.queryByText('7/50')).toBeNull());
    expect(screen.getByText('2/50')).toBeTruthy();
    expect(posted.find((p) => p.method === 'DELETE')!.url).toBe(`/invites/${inv('01JB').id}`);
  });

  it('owner sees role select, admin does not', async () => {
    open('owner');
    await screen.findByText('Bob');
    expect(screen.getByLabelText('Role for Bob')).toBeTruthy();
    expect(screen.queryByLabelText('Role for Ann')).toBeNull();
    cleanup();
    open('admin');
    await screen.findByText('Bob');
    expect(screen.queryByLabelText('Role for Bob')).toBeNull();
  });

  it('deactivate then reactivate toggles the button', async () => {
    const posted = open('admin');
    const row = (await screen.findByText('Bob')).closest('tr')!;
    expect(within(screen.getByText('Ann').closest('tr')!).queryByRole('button')).toBeNull();
    expect(within(screen.getByText('Me').closest('tr')!).queryByRole('button')).toBeNull();
    await userEvent.click(within(row).getByRole('button', { name: 'Deactivate' }));
    await within(row).findByRole('button', { name: 'Reactivate' });
    expect(within(row).getByText('Deactivated')).toBeTruthy();
    await userEvent.click(within(row).getByRole('button', { name: 'Reactivate' }));
    await within(row).findByRole('button', { name: 'Deactivate' });
    expect(posted.filter((p) => p.method === 'PATCH').map((p) => p.body)).toEqual([{ deactivated: true }, { deactivated: false }]);
  });

  it('shows API error messages in an alert', async () => {
    stubApi({ bootstrap: () => makeBootstrap({}, 'admin'), route: (url, init) => (url.startsWith('/invites/') ? err(404, 'not_found') : url === '/w/clubhack/invites' && (init?.method ?? 'GET') === 'GET' ? { invites: [inv('01JA')] } : url === '/w/clubhack/members' ? { members: members() } : undefined) });
    history.replaceState(null, '', '/client/clubhack/admin');
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    expect((await screen.findByRole('alert')).textContent).toBe('not_found');
  });

  it('non-admin sees the not-allowed message', async () => {
    const posted = open('member');
    expect(await screen.findByText('You need to be an admin to see this page.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to chat' }).getAttribute('href')).toBe('/client/clubhack');
    expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u).includes('/members'))).toBe(false);
    expect(posted).toHaveLength(0);
  });
});
