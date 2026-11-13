import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { App } from '../src/App';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  history.replaceState(null, '', '/');
});

// Production renders without StrictMode, so the redirect effect runs once. It fires
// before App's own effects (children first); App must still pick up the new path.
it('opening / lands on the workspace route and renders it (no StrictMode)', async () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
  history.replaceState(null, '', '/');
  render(<App />);
  await waitFor(() => expect(location.pathname).toBe('/client/clubhack'));
  expect((await screen.findByRole('status')).textContent).toBe('Loading…');
});
