import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const invoke = vi.fn();
const listen = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: (...a: unknown[]) => listen(...a) }));

import { desktopLoginChallenge, desktopNotify, desktopSetBadge, isDesktop, onDesktopNavigate } from '../src/desktop/bridge';
import { Login } from '../src/pages/Login';
import { Verify } from '../src/pages/Verify';
import { App } from '../src/App';
import { FakeWebSocket } from './fakeSocket';
import { GEN, RAND, boot, chan, id, makeBootstrap, msg, stubApi, BOB } from './harness';

const CHALLENGE = 'c'.repeat(43);
const markDesktop = () => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
};

beforeEach(() => {
  invoke.mockReset();
  listen.mockReset();
  invoke.mockImplementation(async (cmd: string) => (cmd === 'login_challenge' ? CHALLENGE : undefined));
  listen.mockImplementation(async () => () => {});
  FakeWebSocket.reset();
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  history.replaceState(null, '', '/');
});

describe('bridge outside desktop', () => {
  it('isDesktop false in jsdom; all bridge calls are no-ops', async () => {
    expect(isDesktop()).toBe(false);
    await desktopNotify({ title: 't', body: 'b', channelId: 'c' });
    await desktopSetBadge(3);
    expect(await desktopLoginChallenge()).toBe('');
    const off = onDesktopNavigate(() => {});
    off();
    expect(invoke).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });
});

describe('bridge in desktop', () => {
  it('invokes commands with camelCase args, clamps the badge, and swallows errors', async () => {
    markDesktop();
    expect(isDesktop()).toBe(true);
    await desktopNotify({ title: 't', body: 'b', channelId: 'c' });
    expect(invoke).toHaveBeenCalledWith('notify', { title: 't', body: 'b', channelId: 'c' });
    await desktopSetBadge(123456);
    expect(invoke).toHaveBeenLastCalledWith('set_badge', { count: 9999 });
    await desktopSetBadge(-4);
    expect(invoke).toHaveBeenLastCalledWith('set_badge', { count: 0 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    invoke.mockRejectedValue(new Error('secret-detail'));
    await expect(desktopNotify({ title: 't', body: 'b', channelId: 'c' })).resolves.toBeUndefined();
    expect(await desktopLoginChallenge()).toBe('');
    expect(warn.mock.calls.flat().join(' ')).not.toContain('secret-detail');
    expect(warn).toHaveBeenCalledWith('desktop command failed: notify');
  });
});

describe('desktop login pages', () => {
  it('Login submits desktopChallenge from login_challenge', async () => {
    markDesktop();
    const f = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', f);
    history.replaceState(null, '', '/login');
    render(<Login />);
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.co');
    await userEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/auth/start');
    expect(JSON.parse(init.body as string)).toEqual({ email: 'a@b.co', desktopChallenge: CHALLENGE });
  });

  it('Verify with desktopCode shows "Opening Backroom…" and sets location to backroom://auth?code=<code>', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { search: '?t=tok', pathname: '/verify', hash: '', assign });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: true, workspace: 'clubhack', desktopCode: 'abc123' }), { status: 200 })),
    );
    render(<Verify />);
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Opening Backroom…')).toBeTruthy();
    expect(assign).toHaveBeenCalledWith('backroom://auth?code=abc123');
  });

  it('Verify without desktopCode navigates to /client/clubhack as before', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: true, workspace: 'clubhack' }), { status: 200 })),
    );
    history.replaceState(null, '', '/verify?t=tok');
    render(<Verify />);
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(location.pathname).toBe('/client/clubhack'));
  });
});

describe('/desktop-auth', () => {
  it('exchanges code and verifier from the hash, clears it, and navigates', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ ok: true, workspace: 'clubhack' }), { status: 200 }));
    vi.stubGlobal('fetch', f);
    history.replaceState(null, '', '/desktop-auth#code=the-code&verifier=the-verifier');
    render(<App />);
    await waitFor(() => expect(location.pathname).toBe('/client/clubhack'));
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/auth/desktop/exchange');
    expect(JSON.parse(init.body as string)).toEqual({ code: 'the-code', verifier: 'the-verifier' });
    expect(location.hash).toBe('');
  });

  it('drops the hash before the POST resolves', async () => {
    let hashAtPost = 'unset';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        hashAtPost = location.hash;
        return new Response(JSON.stringify({ ok: true, workspace: 'clubhack' }), { status: 200 });
      }),
    );
    history.replaceState(null, '', '/desktop-auth#code=x&verifier=y');
    render(<App />);
    await waitFor(() => expect(hashAtPost).toBe(''));
  });

  it('shows an error with a login link on 400', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: 'code_invalid', message: 'nope' } }), { status: 400 }),
      ),
    );
    history.replaceState(null, '', '/desktop-auth#code=x&verifier=y');
    render(<App />);
    expect((await screen.findByRole('alert')).textContent).toBe('This sign-in code is invalid or expired.');
    expect(screen.getByRole('link', { name: /sign in/i }).getAttribute('href')).toBe('/login');
    expect(location.pathname).toBe('/desktop-auth');
  });

  it('does not read the query string', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    history.replaceState(null, '', '/desktop-auth?code=x&verifier=y');
    render(<App />);
    expect((await screen.findByRole('alert')).textContent).toBe('This sign-in code is invalid or expired.');
    expect(f).not.toHaveBeenCalled();
  });
});

describe('desktop workspace wiring', () => {
  it('notify frame in desktop calls desktopNotify instead of new Notification', async () => {
    markDesktop();
    const ctor = vi.fn();
    vi.stubGlobal('Notification', class { static permission = 'granted'; constructor() { ctor(); } });
    stubApi();
    const ws = await boot(`/client/clubhack/${GEN}`);
    act(() =>
      ws.receive({ t: 'notify', kind: 'mention', channelId: RAND, messageId: id('01JN'), parentId: null, fromUserId: BOB, preview: 'hi' }),
    );
    expect(invoke).toHaveBeenCalledWith('notify', { title: '#random', body: 'hi', channelId: RAND });
    expect(ctor).not.toHaveBeenCalled();
  });

  it('total unread change calls desktopSetBadge(total)', async () => {
    markDesktop();
    stubApi({
      bootstrap: () =>
        makeBootstrap({ channels: [chan(GEN, 'general', { unreadCount: 2, lastSeq: 2 }), chan(RAND, 'random', { unreadCount: 3, lastSeq: 3 })] }),
    });
    const ws = await boot(`/client/clubhack/${GEN}`);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('set_badge', { count: 3 }));
    act(() => ws.receive({ t: 'message.new', message: msg(4, { channelId: RAND }) }));
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith('set_badge', { count: 4 }));
  });

  it('backroom://navigate event navigates to /client/clubhack/<channelId>', async () => {
    markDesktop();
    let cb: ((e: { payload: { channelId: string } }) => void) | undefined;
    listen.mockImplementation(async (name: string, h: typeof cb) => {
      if (name === 'backroom://navigate') cb = h;
      return () => {};
    });
    stubApi();
    await boot(`/client/clubhack/${GEN}`);
    await waitFor(() => expect(cb).toBeDefined());
    act(() => cb!({ payload: { channelId: RAND } }));
    expect(location.pathname).toBe(`/client/clubhack/${RAND}`);
  });

  it('hides the notifications button in desktop', async () => {
    markDesktop();
    vi.stubGlobal('Notification', class { static permission = 'default'; });
    stubApi();
    await boot(`/client/clubhack/${GEN}`);
    await screen.findByRole('button', { name: '#general' });
    expect(screen.queryByRole('button', { name: 'Enable notifications' })).toBeNull();
  });
});
