import { useEffect } from 'react';
import { navigate } from '../nav';

export function Invite({ token }: { token: string }) {
  useEffect(() => navigate(`/login?invite=${encodeURIComponent(token)}`, { replace: true }), [token]);
  return null;
}
