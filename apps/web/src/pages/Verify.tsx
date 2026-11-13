import { useState } from 'react';
import { api } from '../api';
import { navigate } from '../nav';

export function Verify() {
  const token = new URLSearchParams(location.search).get('t') ?? '';
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // The desktop scheme URL once the code is handed over (also offered as a manual link).
  const [appUrl, setAppUrl] = useState('');

  async function signIn() {
    setBusy(true);
    setError('');
    try {
      const res = await api<{ ok: true; workspace: string; desktopCode?: string }>('/auth/verify', {
        method: 'POST',
        body: { token },
      });
      if (res.desktopCode) {
        // The sign-in belongs to the desktop app: hand the one-time code over via its URL scheme.
        const url = `backroom://auth?code=${encodeURIComponent(res.desktopCode)}`;
        setAppUrl(url);
        location.assign(url);
        return;
      }
      navigate(`/client/${res.workspace}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      setBusy(false);
    }
  }

  if (appUrl)
    return (
      <main className="card">
        <h1>Finish signing in</h1>
        <p role="status">Opening Backroom…</p>
        <p>
          <a href={appUrl}>Open Backroom</a>
        </p>
        <p>Nothing happened? Make sure the Backroom app is installed, then request a new link from it.</p>
      </main>
    );

  return (
    <main className="card">
      <h1>Finish signing in</h1>
      <button type="button" onClick={signIn} disabled={busy || !token}>
        Sign in
      </button>
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
