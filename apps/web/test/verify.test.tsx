import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Verify } from '../src/pages/Verify';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  history.replaceState(null, '', '/');
});

describe('Verify', () => {
  it('does not call the API until Sign in is clicked', async () => {
    const f = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, workspace: 'clubhack' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', f);
    history.replaceState(null, '', '/verify?t=tok123');
    render(<Verify />);
    expect(f).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/auth/verify');
    expect(init.body).toBe('{"token":"tok123"}');
    expect(location.pathname).toBe('/client/clubhack');
  });

  it('shows the API error message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: 'link_invalid', message: 'That link is invalid.' } }), {
            status: 400,
          }),
      ),
    );
    history.replaceState(null, '', '/verify?t=tok123');
    render(<Verify />);
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect((await screen.findByRole('alert')).textContent).toBe('That link is invalid.');
  });
});
