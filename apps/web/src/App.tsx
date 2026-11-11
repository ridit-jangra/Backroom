import { useEffect, useState } from 'react';
import { navigate } from './nav';
import { Login } from './pages/Login';
import { Verify } from './pages/Verify';
import { Invite } from './pages/Invite';
import { Workspace } from './pages/Workspace';

export const DEFAULT_WORKSPACE = 'clubhack';

function Redirect({ to }: { to: string }) {
  useEffect(() => navigate(to, { replace: true }), [to]);
  return null;
}

export function App() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  if (path === '/') return <Redirect to={`/client/${DEFAULT_WORKSPACE}`} />;
  if (path === '/login') return <Login />;
  if (path === '/verify') return <Verify />;
  const invite = /^\/invite\/([^/]+)$/.exec(path);
  if (invite) return <Invite token={decodeURIComponent(invite[1]!)} />;
  const ws = /^\/client\/([^/]+)$/.exec(path);
  if (ws) return <Workspace slug={decodeURIComponent(ws[1]!)} />;
  return (
    <main className="card">
      <h1>Not found</h1>
      <p>
        <a href="/">Go home</a>
      </p>
    </main>
  );
}
