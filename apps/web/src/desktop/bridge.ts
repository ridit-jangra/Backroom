import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/** Largest badge count passed to the shell. */
export const MAX_BADGE = 9999;

export const NAVIGATE_EVENT = 'backroom://navigate';

/** True only inside the Tauri shell; a normal browser never touches Tauri internals. */
export function isDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/** Runs a shell command; failures log the command name only (arguments may be sensitive). */
async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | undefined> {
  if (!isDesktop()) return undefined;
  try {
    return await invoke<T>(cmd, args);
  } catch {
    console.warn(`desktop command failed: ${cmd}`);
    return undefined;
  }
}

export async function desktopNotify(n: { title: string; body: string; channelId: string }): Promise<void> {
  await call('notify', { title: n.title, body: n.body, channelId: n.channelId });
}

export async function desktopSetBadge(count: number): Promise<void> {
  const n = Number.isFinite(count) ? Math.min(MAX_BADGE, Math.max(0, Math.floor(count))) : 0;
  await call('set_badge', { count: n });
}

/** PKCE challenge for the desktop login hand-off; empty when unavailable. */
export async function desktopLoginChallenge(): Promise<string> {
  const c = await call<string>('login_challenge');
  return typeof c === 'string' ? c : '';
}

/** Calls `cb` when the shell asks to open a channel (notification click). Returns an unsubscribe. */
export function onDesktopNavigate(cb: (channelId: string) => void): () => void {
  if (!isDesktop()) return () => {};
  let off: (() => void) | null = null;
  let stopped = false;
  listen<{ channelId: string }>(NAVIGATE_EVENT, (e) => {
    const id = e.payload?.channelId;
    if (typeof id === 'string' && id) cb(id);
  }).then(
    (un) => {
      if (stopped) un();
      else off = un;
    },
    () => console.warn(`desktop listen failed: ${NAVIGATE_EVENT}`),
  );
  return () => {
    stopped = true;
    off?.();
    off = null;
  };
}
