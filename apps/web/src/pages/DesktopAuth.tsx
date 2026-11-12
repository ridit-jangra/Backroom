import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { navigate } from '../nav';

const INVALID = 'This sign-in code is invalid or expired.';

/** Reads code and verifier from the URL fragment only (never the query), drops them, then exchanges. */
export function DesktopAuth() {
  const [error, setError] = useState('');
  // StrictMode runs effects twice on one instance: exchange exactly once, and let a re-run
  // re-attach to the in-flight result instead of re-reading the (already cleared) fragment.
  const started = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    if (started.current) {
      return () => {
        mounted.current = false;
      };
    }
    started.current = true;
    const params = new URLSearchParams(location.hash.replace(/^#/, ''));
    const code = params.get('code');
    const verifier = params.get('verifier');
    history.replaceState(null, '', location.pathname);
    if (!code || !verifier) {
      setError(INVALID);
      return;
    }
    api<{ ok: true; workspace: string }>('/auth/desktop/exchange', {
      method: 'POST',
      body: { code, verifier },
    }).then(
      (res) => {
        if (mounted.current) navigate(`/client/${res.workspace}`, { replace: true });
      },
      (err) => {
        if (!mounted.current) return;
        const status = (err as { status?: number }).status;
        setError(status === 400 ? INVALID : err instanceof Error ? err.message : 'Something went wrong');
      },
    );
    return () => {
      mounted.current = false;
    };
  }, []);

  return (
    <main className="card">
      <h1>Signing in…</h1>
      {error ? (
        <>
          <p role="alert">{error}</p>
          <p>
            <a href="/login">Back to sign in</a>
          </p>
        </>
      ) : (
        <p role="status">Finishing sign-in…</p>
      )}
    </main>
  );
}
