import { useEffect, useState } from 'react';
import { navigate } from './nav';
import { Login } from './pages/Login';
import { Verify } from './pages/Verify';
import { Invite } from './pages/Invite';
import { Admin } from './pages/Admin';
import { Workspace } from './pages/Workspace';
import { About } from './pages/About';

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
  if (path === '/about') return <About />;
  const invite = /^\/invite\/([^/]+)$/.exec(path);
  if (invite) return <Invite token={decodeURIComponent(invite[1]!)} />;
  // P2-R11: the admin route wins over the channel route, and channel segments must be wire IDs.
  const admin = /^\/client\/([^/]+)\/admin$/.exec(path);
  if (admin) return <Admin slug={decodeURIComponent(admin[1]!)} />;
  const ws = /^\/client\/([^/]+)(?:\/([0-9A-Z]{26}))?$/.exec(path);
  if (ws) return <Workspace key={ws[1]} slug={decodeURIComponent(ws[1]!)} channelId={ws[2]} />;
  return (
    <main className="card">
      <h1>Not found</h1>
      <p>
        <a href="/">Go home</a>
      </p>
    </main>
  );
}
