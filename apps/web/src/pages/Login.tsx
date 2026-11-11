import { useState, type FormEvent } from 'react';
import { api } from '../api';

export function Login() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const inviteToken = new URLSearchParams(location.search).get('invite');
    try {
      await api('/auth/start', {
        method: 'POST',
        body: inviteToken ? { email, inviteToken } : { email },
      });
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="card">
      <h1>Sign in to Backroom</h1>
      {sent ? (
        <p role="status">
          Check your email — if this address can join, a sign-in link is on its way. It expires in
          15 minutes.
        </p>
      ) : (
        <form onSubmit={submit}>
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <button type="submit" disabled={busy}>
            Email me a sign-in link
          </button>
          {error && <p role="alert">{error}</p>}
        </form>
      )}
    </main>
  );
}
