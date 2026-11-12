import { act, render, waitFor } from '@testing-library/react';
import { expect, vi } from 'vitest';
import type { Bootstrap, Message } from '@backroom/protocol';
import { App } from '../src/App';
import { FakeWebSocket } from './fakeSocket';

export const id = (p: string) => p.padEnd(26, '0');
export const GEN = id('01JGENERAL');
export const RAND = id('01JRANDOM');
export const ME = id('01JME');
export const BOB = id('01JBOB');
export const ANN = id('01JANN');

export function chan(cid: string, name: string, o: Partial<Bootstrap['channels'][number]> = {}): Bootstrap['channels'][number] {
  return { id: cid, kind: 'public', name, topic: null, createdBy: ANN, dmUserIds: null, lastSeq: 0, lastReadSeq: 0, unreadCount: 0, mentionCount: 0, ...o };
}

export function makeBootstrap(o: Partial<Bootstrap> = {}, role: 'member' | 'admin' = 'member'): Bootstrap {
  return {
    workspace: { id: 'w', slug: 'clubhack', name: 'Club Hack' },
    me: { id: ME, email: 'me@example.com', displayName: 'Me', role },
    channels: [chan(GEN, 'general'), chan(RAND, 'random')],
    members: [
      { id: ME, displayName: 'Me', role, avatarKey: null },
      { id: BOB, displayName: 'Bob', role: 'member', avatarKey: null },
      { id: ANN, displayName: 'Ann', role: 'owner', avatarKey: null },
    ],
    ...o,
  };
}

let mid = 0;
export function msg(seq: number, o: Partial<Message> = {}): Message {
  mid++;
  return {
    id: id(`01JM${mid}X`), channelId: GEN, seq, userId: BOB, parentId: null, body: `message ${seq}`,
    alsoInChannel: false, createdAt: 1_700_000_000_000 + seq * 1000, editedAt: null, deletedAt: null,
    replyCount: 0, lastReplyAt: null, ...o,
  };
}

export type Route = (url: string, init: { method?: string; body?: string } | undefined) => unknown;
export type Posted = { url: string; method: string; body: unknown };

/** Stubs fetch: `route` answers a request with `Response`/JSON or returns undefined to fall through. */
export function stubApi(opts: { bootstrap?: () => Bootstrap; pages?: Record<string, { messages: Message[]; hasMore: boolean }>; route?: Route } = {}) {
  const posted: Posted[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET';
      if (method !== 'GET') posted.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
      const custom = opts.route?.(url, init);
      if (custom instanceof Response) return custom;
      if (custom !== undefined) return new Response(JSON.stringify(custom), { status: 200 });
      if (url.endsWith('/bootstrap')) return new Response(JSON.stringify((opts.bootstrap ?? makeBootstrap)()), { status: 200 });
      const hist = /^\/channels\/([0-9A-Z]{26})\/messages\?/.exec(url);
      if (hist) return new Response(JSON.stringify(opts.pages?.[hist[1]!] ?? { messages: [], hasMore: false }), { status: 200 });
      return new Response(JSON.stringify({ error: { code: 'not_found', message: 'nf' } }), { status: 404 });
    }),
  );
  return posted;
}

export const err = (status: number, code: string) => new Response(JSON.stringify({ error: { code, message: code } }), { status });

export async function boot(path = `/client/clubhack/${GEN}`): Promise<FakeWebSocket> {
  history.replaceState(null, '', path);
  render(<App />);
  await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
  act(() => FakeWebSocket.instances[0]!.open());
  return FakeWebSocket.instances[0]!;
}

export const frames = (w: FakeWebSocket) => w.sent.map((s) => JSON.parse(s) as { t: string; [k: string]: unknown });
