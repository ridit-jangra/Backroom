import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Workspace } from '../src/pages/Workspace';
import { App } from '../src/App';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  history.replaceState(null, '', '/');
});

const bootstrap = {
  workspace: { id: 'w', slug: 'clubhack', name: 'Club Hack' },
  channels: [{ id: 'c1', kind: 'public', name: 'general', unreadCount: 0, mentionCount: 0 }],
  members: [{ id: 'u1', displayName: 'Owner' }],
};

function stub(logoutStatus: number | 'network') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.endsWith('/bootstrap')) return new Response(JSON.stringify(bootstrap), { status: 200 });
      if (logoutStatus === 'network') throw new TypeError('offline');
      return new Response(JSON.stringify(logoutStatus === 200 ? { ok: true } : { error: { code: 'x', message: 'x' } }), {
        status: logoutStatus,
      });
    }),
  );
}

describe('Workspace sign out', () => {
  it('stays and shows an alert when logout fails', async () => {
    stub('network');
    history.replaceState(null, '', '/client/clubhack');
    render(<Workspace slug="clubhack" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      "Couldn't sign out. Check your connection and try again.",
    );
    expect(location.pathname).toBe('/client/clubhack');
  });

  it('navigates to /login on success and on 401', async () => {
    for (const status of [200, 401]) {
      cleanup();
      stub(status);
      history.replaceState(null, '', '/client/clubhack');
      render(<Workspace slug="clubhack" />);
      await userEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
      expect(location.pathname).toBe('/login');
    }
  });
});

describe('navigation', () => {
  it('the / redirect uses replaceState', () => {
    const replace = vi.spyOn(history, 'replaceState');
    const push = vi.spyOn(history, 'pushState');
    stub(200);
    history.replaceState(null, '', '/');
    replace.mockClear();
    render(<App />);
    expect(replace).toHaveBeenCalledWith(null, '', '/client/clubhack');
    expect(push).not.toHaveBeenCalled();
  });
});
