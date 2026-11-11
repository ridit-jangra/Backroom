import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Login } from '../src/pages/Login';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  history.replaceState(null, '', '/');
});

function stubOk() {
  const f = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal('fetch', f);
  return f;
}

describe('Login', () => {
  it('submits email and shows confirmation', async () => {
    const f = stubOk();
    history.replaceState(null, '', '/login');
    render(<Login />);
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.co');
    await userEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/auth/start');
    expect(init.body).toBe('{"email":"a@b.co"}');
    expect(await screen.findByText(/Check your email/)).toBeTruthy();
  });

  it('includes the invite token from the URL', async () => {
    const f = stubOk();
    history.replaceState(null, '', '/login?invite=XYZ');
    render(<Login />);
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.co');
    await userEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
    const [, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBe('{"email":"a@b.co","inviteToken":"XYZ"}');
  });
});
