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
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('complementary', { name: 'Search results' })).toBeNull();
  });
});
