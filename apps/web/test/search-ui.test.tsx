import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Message, SearchHit } from '@backroom/protocol';
import { FakeWebSocket } from './fakeSocket';
import { BOB, GEN, RAND, boot, chan, id, makeBootstrap, msg, stubApi, type Route } from './harness';

beforeEach(() => {
  FakeWebSocket.reset();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  history.replaceState(null, '', '/');
});

const hit = (m: Message, o: Partial<SearchHit['channel']> = {}, snippet = [{ text: 'a ', hit: false }, { text: 'zebra', hit: true }]): SearchHit => ({
  message: m,
  channel: { id: m.channelId, name: m.channelId === RAND ? 'random' : 'general', kind: 'public', isMember: true, ...o },
  snippet,
});
const calls = () => vi.mocked(fetch as unknown as (u: string) => unknown).mock.calls.map(([u]) => String(u));

async function search(text: string) {
  const box = screen.getByRole('searchbox', { name: 'Search messages' });
  await userEvent.type(box, `${text}{Enter}`);
}

describe('search UI', () => {
  it('submitting the box requests the search and shows highlighted snippets as text', async () => {
    const route: Route = (url) =>
      url.startsWith('/w/clubhack/search')
        ? { results: [hit(msg(1), {}, [{ text: 'zebra', hit: true }, { text: ` see <@${BOB}>`, hit: false }])], nextCursor: null }
        : undefined;
    stubApi({ route });
    await boot();
    await screen.findByRole('searchbox', { name: 'Search messages' });
    await search('zebra <b>');
    const panel = await screen.findByRole('complementary', { name: 'Search results' });
    await waitFor(() => expect(panel.querySelector('mark')?.textContent).toBe('zebra'));
    expect(calls()).toContain('/w/clubhack/search?q=zebra%20%3Cb%3E');
    expect(panel.querySelector('b')).toBeNull();
    expect(panel.textContent).toContain('see @Bob');
    expect(panel.textContent).toContain('#general');
    expect(panel.textContent).toContain('Bob');
    expect(panel.textContent).toContain('Filters: in:#channel from:@name has:file before:YYYY-MM-DD after:YYYY-MM-DD');
  });

  it('partial mention fragments stay plain text', async () => {
    const route: Route = (url) =>
      url.startsWith('/w/clubhack/search') ? { results: [hit(msg(1), {}, [{ text: '<@01JBOB000', hit: false }])], nextCursor: null } : undefined;
    stubApi({ route });
    await boot();
    await screen.findByRole('searchbox');
    await search('x');
    expect(await screen.findByText(/<@01JBOB000/)).toBeTruthy();
  });

  it('load more uses the cursor', async () => {
    const a = msg(1, { body: 'first' });
    const b = msg(2, { body: 'second' });
    const route: Route = (url) => {
      if (!url.startsWith('/w/clubhack/search')) return undefined;
      return url.includes('cursor=C1')
        ? { results: [hit(b, {}, [{ text: 'second', hit: false }])], nextCursor: null }
        : { results: [hit(a, {}, [{ text: 'first', hit: false }])], nextCursor: 'C1' };
    };
    stubApi({ route });
    await boot();
    await screen.findByRole('searchbox');
    await search('q');
    await userEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    await screen.findByText('second');
    expect(screen.getByText('first')).toBeTruthy();
    expect(calls()).toContain('/w/clubhack/search?q=q&cursor=C1');
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('empty and error states', async () => {
    let mode: 'empty' | 'bad' = 'empty';
    const route: Route = (url) => {
      if (!url.startsWith('/w/clubhack/search')) return undefined;
      return mode === 'empty'
        ? { results: [], nextCursor: null }
        : new Response(JSON.stringify({ error: { code: 'invalid_date', message: 'Dates use YYYY-MM-DD.' } }), { status: 400 });
    };
    stubApi({ route });
    await boot();
    await screen.findByRole('searchbox');
    await search('nothing');
    expect(await screen.findByText('No results')).toBeTruthy();
    mode = 'bad';
    await userEvent.type(screen.getByRole('searchbox'), ' before:x{Enter}');
    expect((await screen.findByRole('alert')).textContent).toBe('Dates use YYYY-MM-DD.');
  });

  it('clicking a result jumps to the message', async () => {
    const rand = Array.from({ length: 5 }, (_, i) => msg(i + 1, { channelId: RAND }));
    const route: Route = (url) =>
      url.startsWith('/w/clubhack/search') ? { results: [hit(rand[2]!, {}, [{ text: 'target', hit: true }])], nextCursor: null } : undefined;
    stubApi({ route, pages: { [RAND]: rand } });
    await boot();
    await screen.findByRole('searchbox');
    await search('target');
    const panel = await screen.findByRole('complementary', { name: 'Search results' });
    await userEvent.click(await within(panel).findByRole('button', { name: /random/ }));
    await waitFor(() => expect(location.pathname).toBe(`/client/clubhack/${RAND}`));
    await waitFor(() => expect(document.querySelector('.msg.highlighted')).not.toBeNull());
  });

  it('a thread reply opens the thread', async () => {
    const parent = msg(1, { replyCount: 1 });
    const reply = msg(2, { parentId: parent.id });
    const route: Route = (url) => {
      if (url.startsWith('/w/clubhack/search')) return { results: [hit(reply)], nextCursor: null };
      if (url === `/messages/${parent.id}/thread`) return { parent, replies: [reply] };
      return undefined;
    };
    stubApi({ route, pages: { [GEN]: [parent] } });
    await boot();
    await screen.findByRole('searchbox');
    await search('zebra');
    const panel = await screen.findByRole('complementary', { name: 'Search results' });
    await userEvent.click(await within(panel).findByRole('button', { name: /general/ }));
    await waitFor(() => expect(calls()).toContain(`/messages/${parent.id}/thread`));
  });

  it('non-member public channel joins first', async () => {
    const ZOO = id('01JZOO');
    const zm = msg(1, { channelId: ZOO });
    const route: Route = (url) => {
      if (url.startsWith('/w/clubhack/search')) return { results: [hit(zm, { id: ZOO, name: 'zoo', isMember: false })], nextCursor: null };
      if (url === `/channels/${ZOO}/join`) return {};
      return undefined;
    };
    const posted = stubApi({ route, pages: { [ZOO]: [zm] } });
    await boot();
    await screen.findByRole('searchbox');
    await search('zebra');
    await userEvent.click(await screen.findByRole('button', { name: 'Join #zoo to view' }));
    await waitFor(() => expect(posted.some((p) => p.url === `/channels/${ZOO}/join` && p.method === 'POST')).toBe(true));
    await waitFor(() => expect(location.pathname).toBe(`/client/clubhack/${ZOO}`));
  });

  it('Escape closes the panel', async () => {
    const route: Route = (url) => (url.startsWith('/w/clubhack/search') ? { results: [], nextCursor: null } : undefined);
    stubApi({ route, bootstrap: () => makeBootstrap({ channels: [chan(GEN, 'general')] }) });
    await boot();
    await screen.findByRole('searchbox');
    await search('x');
    await screen.findByRole('complementary', { name: 'Search results' });
    fireEvent.keyDown(screen.getByRole('complementary', { name: 'Search results' }), { key: 'Escape' });
    expect(screen.queryByRole('complementary', { name: 'Search results' })).toBeNull();
  });

  it('Escape outside the panel does not close it', async () => {
    const route: Route = (url) => (url.startsWith('/w/clubhack/search') ? { results: [], nextCursor: null } : undefined);
    stubApi({ route });
    await boot();
    await screen.findByRole('searchbox');
    await search('x');
    await screen.findByRole('complementary', { name: 'Search results' });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('complementary', { name: 'Search results' })).not.toBeNull();
  });

  it('searching while a thread is open shows the search panel', async () => {
    const parent = msg(1, { replyCount: 1 });
    const reply = msg(2, { parentId: parent.id });
    const route: Route = (url) => {
      if (url.startsWith('/w/clubhack/search')) return { results: [], nextCursor: null };
      if (url === `/messages/${parent.id}/thread`) return { parent, replies: [reply] };
      return undefined;
    };
    stubApi({ route, pages: { [GEN]: [parent] } });
    await boot();
    await userEvent.click(await screen.findByRole('button', { name: /1 repl/i }));
    await screen.findByRole('complementary', { name: 'Thread' });
    await search('zebra');
    expect(await screen.findByRole('complementary', { name: 'Search results' })).toBeTruthy();
  });

  it('load more drops overlapping results', async () => {
    const a = msg(1);
    const b = msg(2);
    const route: Route = (url) => {
      if (!url.startsWith('/w/clubhack/search')) return undefined;
      return url.includes('cursor=C1')
        ? { results: [hit(a, {}, [{ text: 'first', hit: false }]), hit(b, {}, [{ text: 'second', hit: false }])], nextCursor: null }
        : { results: [hit(a, {}, [{ text: 'first', hit: false }])], nextCursor: 'C1' };
    };
    stubApi({ route });
    await boot();
    await screen.findByRole('searchbox');
    await search('q');
    await userEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    await screen.findByText('second');
    expect(screen.getAllByText('first')).toHaveLength(1);
  });

  it('a stale response never replaces newer results', async () => {
    let releaseFirst: (r: Response) => void = () => undefined;
    const route: Route = (url) =>
      url.startsWith('/w/clubhack/search') && !url.includes('q=one')
        ? { results: [hit(msg(1), {}, [{ text: 'newer', hit: false }])], nextCursor: null }
        : undefined;
    stubApi({ route });
    const inner = fetch as unknown as (u: string, i?: unknown) => Promise<Response>;
    vi.stubGlobal('fetch', vi.fn((u: string, i?: unknown) =>
      u.includes('q=one') ? new Promise<Response>((r) => (releaseFirst = r)) : inner(u, i)));
    await boot();
    await screen.findByRole('searchbox');
    await search('one');
    await userEvent.clear(screen.getByRole('searchbox', { name: 'Search messages' }));
    await search('two');
    await screen.findByText('newer');
    releaseFirst(new Response(JSON.stringify({ results: [hit(msg(2), {}, [{ text: 'older', hit: false }])], nextCursor: null }), { status: 200 }));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('older')).toBeNull();
    expect(screen.getByText('newer')).toBeTruthy();
  });

  it('join failure shows the error and does not jump; success joins before navigating', async () => {
    const ZOO = id('01JZOO');
    const zm = msg(1, { channelId: ZOO });
    let fail = true;
    const order: string[] = [];
    const route: Route = (url) => {
      if (url.startsWith('/w/clubhack/search')) return { results: [hit(zm, { id: ZOO, name: 'zoo', isMember: false })], nextCursor: null };
      if (url === `/channels/${ZOO}/join`) {
        order.push(`join:${location.pathname}`);
        return fail ? new Response(JSON.stringify({ error: { code: 'forbidden', message: 'Cannot join.' } }), { status: 403 }) : {};
      }
      return undefined;
    };
    stubApi({ route, pages: { [ZOO]: [zm] } });
    await boot();
    await screen.findByRole('searchbox');
    await search('zebra');
    await userEvent.click(await screen.findByRole('button', { name: 'Join #zoo to view' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Cannot join.');
    expect(location.pathname).toBe(`/client/clubhack/${GEN}`);
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Join #zoo to view' }));
    await waitFor(() => expect(location.pathname).toBe(`/client/clubhack/${ZOO}`));
    expect(order).toEqual([`join:/client/clubhack/${GEN}`, `join:/client/clubhack/${GEN}`]);
  });

  it('jumpTo returning false shows the too-far-back alert', async () => {
    const many = Array.from({ length: 1500 }, (_, i) => msg(i + 1));
    const route: Route = (url) =>
      url.startsWith('/w/clubhack/search') ? { results: [hit(many[0]!)], nextCursor: null } : undefined;
    stubApi({ route, pages: { [GEN]: many } });
    await boot();
    await screen.findByRole('searchbox');
    await search('old');
    const panel = await screen.findByRole('complementary', { name: 'Search results' });
    await userEvent.click(await within(panel).findByRole('button', { name: /general/ }));
    expect((await screen.findByText('That message is too far back to show here.')).getAttribute('role')).toBe('alert');
  });

  it('a rejecting jump shows the alert text', async () => {
    const m = msg(1, { channelId: RAND });
    const route: Route = (url) => {
      if (url.startsWith('/w/clubhack/search')) return { results: [hit(m)], nextCursor: null };
      if (url.startsWith(`/channels/${RAND}/messages`)) return new Response('x', { status: 500 });
      return undefined;
    };
    stubApi({ route });
    await boot();
    await screen.findByRole('searchbox');
    await search('x');
    const panel = await screen.findByRole('complementary', { name: 'Search results' });
    await userEvent.click(await within(panel).findByRole('button', { name: /random/ }));
    await waitFor(() => expect(screen.queryAllByRole('alert').length).toBeGreaterThan(0));
    expect(screen.getAllByRole('alert').map((a) => a.textContent)).toEqual(['That message is too far back to show here.']);
  });

  it('join refreshes bootstrap before navigating, posts once for double-click and not again after success', async () => {
    const ZOO = id('01JZOO');
    const zm = msg(1, { channelId: ZOO });
    const log: string[] = [];
    const route: Route = (url, init) => {
      if (url.startsWith('/w/clubhack/search')) return { results: [hit(zm, { id: ZOO, name: 'zoo', isMember: false })], nextCursor: null };
      if (url === `/channels/${ZOO}/join`) log.push('join');
      if (/\/bootstrap/.test(url)) log.push(`bootstrap@${location.pathname.endsWith(ZOO) ? 'zoo' : 'gen'}`);
      void init;
      return url === `/channels/${ZOO}/join` ? {} : undefined;
    };
    const posted = stubApi({ route, pages: { [ZOO]: [zm] } });
    await boot();
    await screen.findByRole('searchbox');
    await search('zebra');
    const btn = await screen.findByRole('button', { name: 'Join #zoo to view' });
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(location.pathname).toBe(`/client/clubhack/${ZOO}`));
    expect(posted.filter((p) => p.url === `/channels/${ZOO}/join`)).toHaveLength(1);
    const j = log.indexOf('join');
    expect(log.slice(j + 1)).toContain('bootstrap@gen');
    expect(log.slice(j + 1).indexOf('bootstrap@gen')).toBeGreaterThanOrEqual(0);
    fireEvent.click(screen.getByRole('button', { name: /zoo/ }));
    await new Promise((r) => setTimeout(r, 20));
    expect(posted.filter((p) => p.url === `/channels/${ZOO}/join`)).toHaveLength(1);
  });

  it('manual thread does not hide the search panel; a jump-opened thread does', async () => {
    const parent = msg(1, { replyCount: 1 });
    const reply = msg(2, { parentId: parent.id });
    const route: Route = (url) => {
      if (url.startsWith('/w/clubhack/search')) return { results: [hit(reply)], nextCursor: null };
      if (url === `/messages/${parent.id}/thread`) return { parent, replies: [reply] };
      return undefined;
    };
    stubApi({ route, pages: { [GEN]: [parent] } });
    await boot();
    await screen.findByRole('searchbox');
    await search('zebra');
    await screen.findByRole('complementary', { name: 'Search results' });
    await userEvent.click(await screen.findByRole('button', { name: /1 repl/i }));
    await screen.findByRole('complementary', { name: 'Thread' });
    expect(screen.queryByRole('complementary', { name: 'Search results' })).not.toBeNull();
    await userEvent.click(within(screen.getByRole('complementary', { name: 'Search results' })).getByRole('button', { name: /general/ }));
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Search results' })).toBeNull());
    expect(screen.queryByRole('complementary', { name: 'Thread' })).not.toBeNull();
  });

  it('jumpError clears on a new search', async () => {
    const many = Array.from({ length: 1500 }, (_, i) => msg(i + 1));
    const route: Route = (url) =>
      url.startsWith('/w/clubhack/search') ? { results: [hit(many[0]!)], nextCursor: null } : undefined;
    stubApi({ route, pages: { [GEN]: many } });
    await boot();
    await screen.findByRole('searchbox');
    await search('old');
    const panel = await screen.findByRole('complementary', { name: 'Search results' });
    await userEvent.click(await within(panel).findByRole('button', { name: /general/ }));
    await screen.findByText('That message is too far back to show here.');
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search messages' }), ' more{Enter}');
    await waitFor(() => expect(screen.queryByText('That message is too far back to show here.')).toBeNull());
  });

  it('Escape inside the panel with defaultPrevented keeps it open', async () => {
    const route: Route = (url) => (url.startsWith('/w/clubhack/search') ? { results: [], nextCursor: null } : undefined);
    stubApi({ route });
    await boot();
    await screen.findByRole('searchbox');
    await search('x');
    const panel = await screen.findByRole('complementary', { name: 'Search results' });
    const child = panel.querySelector('p')!;
    child.addEventListener('keydown', (e) => e.preventDefault());
    fireEvent.keyDown(child, { key: 'Escape' });
    expect(screen.queryByRole('complementary', { name: 'Search results' })).not.toBeNull();
  });

  it('closing a jump-opened thread and reopening it manually keeps the search panel', async () => {
    const parent = msg(1, { replyCount: 1 });
    const reply = msg(2, { parentId: parent.id });
    const route: Route = (url) => {
      if (url.startsWith('/w/clubhack/search')) return { results: [hit(reply)], nextCursor: null };
      if (url === `/messages/${parent.id}/thread`) return { parent, replies: [reply] };
      return undefined;
    };
    stubApi({ route, pages: { [GEN]: [parent] } });
    await boot();
    await screen.findByRole('searchbox');
    await search('zebra');
    const panel = await screen.findByRole('complementary', { name: 'Search results' });
    await userEvent.click(within(panel).getByRole('button', { name: /general/ }));
    const thread = await screen.findByRole('complementary', { name: 'Thread' });
    expect(screen.queryByRole('complementary', { name: 'Search results' })).toBeNull();
    await userEvent.click(within(thread).getByRole('button', { name: 'Close' }));
    await screen.findByRole('complementary', { name: 'Search results' });
    await userEvent.click(await screen.findByRole('button', { name: /1 repl/i }));
    await screen.findByRole('complementary', { name: 'Thread' });
    expect(screen.queryByRole('complementary', { name: 'Search results' })).not.toBeNull();
  });
});
