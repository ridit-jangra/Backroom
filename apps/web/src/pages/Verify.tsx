import { useState } from 'react';
import { api } from '../api';
import { navigate } from '../nav';

export function Verify() {
  const token = new URLSearchParams(location.search).get('t') ?? '';
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function signIn() {
    setBusy(true);
    setError('');
    try {
      const res = await api<{ ok: true; workspace: string }>('/auth/verify', {
        method: 'POST',
        body: { token },
      });
      navigate(`/client/${res.workspace}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      setBusy(false);
    }
  }

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
