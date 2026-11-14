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

/**
 * Calls `cb` when the shell asks to open a channel. Returns an unsubscribe.
 *
 * Two paths deliver a channel id (P5-R9):
 * - live: the `backroom://navigate` event (notification click, or a
 *   `backroom://channel/<id>` link while this page listens);
 * - pull: the shell also keeps the last channel link in a one-slot store
 *   (60 s TTL), and right after subscribing we call `take_pending_navigation`
 *   once. This covers a link that cold-started the app before the page loaded.
 *
 * A live event also drains the slot, so a later remount within the TTL does
 * not replay an old link. Once any live event has arrived after subscribing,
 * the pull's result is dropped: the live one is the same link or a newer one.
 */
export function onDesktopNavigate(cb: (channelId: string) => void): () => void {
  if (!isDesktop()) return () => {};
  let off: (() => void) | null = null;
  let stopped = false;
  let sawLive = false;
  listen<{ channelId: string }>(NAVIGATE_EVENT, (e) => {
    const id = e.payload?.channelId;
    if (typeof id !== 'string' || !id) return;
    sawLive = true;
    cb(id);
    // Drain: harmless, since the slot holds this link (or a newer one that arrives live too).
    void call('take_pending_navigation');
  }).then(
    (un) => {
      if (stopped) {
        un();
        return;
      }
      off = un;
      void call<unknown>('take_pending_navigation').then((id) => {
        if (stopped || sawLive || typeof id !== 'string' || !id) return;
        cb(id);
      });
    },
    () => console.warn(`desktop listen failed: ${NAVIGATE_EVENT}`),
  );
  return () => {
    stopped = true;
    off?.();
    off = null;
  };
}
