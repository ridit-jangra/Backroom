import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FakeWebSocket } from './fakeSocket';
import { BOB, GEN, ME, boot, frames, makeBootstrap, msg, stubApi, chan, id } from './harness';

beforeEach(() => {
  FakeWebSocket.reset();
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  history.replaceState(null, '', '/');
});

const parent = msg(1, { body: 'parent text', replyCount: 2, lastReplyAt: 1_700_000_005_000 });
const r1 = msg(2, { parentId: parent.id, body: 'first reply', userId: ME });
const r2 = msg(3, { parentId: parent.id, body: 'second reply' });

function thread(extra: ReturnType<typeof msg>[] = []) {
  return { parent, replies: [r1, r2, ...extra] };
}

async function openThread(route?: Parameters<typeof stubApi>[0]) {
  const posted = stubApi({
    pages: { [GEN]: { messages: [parent], hasMore: false } },
    route: (url) => (url === `/messages/${parent.id}/thread` ? thread() : undefined),
    ...route,
  });
  const ws = await boot();
  await userEvent.click(await screen.findByRole('button', { name: '2 replies' }));
  const panel = await screen.findByRole('complementary', { name: 'Thread' });
  return { ws, panel, posted };
}

describe('Thread panel', () => {
  it('opening "2 replies" loads the thread and shows replies', async () => {
    const { panel } = await openThread();
    await within(panel).findByText('first reply');
    expect(within(panel).getByText('second reply')).toBeTruthy();
    expect(within(panel).getByText('parent text')).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls.some(([u]) => u === `/messages/${parent.id}/thread`)).toBe(true);
    await userEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('complementary', { name: 'Thread' })).toBeNull();
  });

  it('reply with "Also send to #general" sends alsoInChannel true and parentId', async () => {
    const { ws, panel } = await openThread();
    await within(panel).findByText('first reply');
    await userEvent.click(within(panel).getByLabelText('Also send to #general'));
    await userEvent.type(within(panel).getByPlaceholderText('Reply…'), 'hello thread{Enter}');
    const sent = frames(ws).find((f) => f.t === 'send');
    expect(sent).toMatchObject({ channelId: GEN, parentId: parent.id, body: 'hello thread', alsoInChannel: true });
  });

  it('live reply appears in the open thread, bumps the count in the channel and marks the thread read', async () => {
    const { ws, panel } = await openThread();
    await within(panel).findByText('second reply');
    await waitFor(() => expect(frames(ws).some((f) => f.t === 'mark_thread_read' && f.seq === 3)).toBe(true));
    act(() => ws.receive({ t: 'message.new', message: msg(4, { parentId: parent.id, body: 'live reply' }) }));
    expect(await within(panel).findByText('live reply')).toBeTruthy();
    expect(screen.getByRole('log', { name: 'Messages' }).textContent).toContain('3 replies');
    await waitFor(() => expect(frames(ws).some((f) => f.t === 'mark_thread_read' && f.seq === 4 && f.messageId === parent.id)).toBe(true));
  });

  it('in a DM the checkbox says "Also send to conversation"', async () => {
    const DM = id('01JDM');
    const dmParent = msg(1, { channelId: DM, body: 'dm parent', replyCount: 1 });
    stubApi({
      bootstrap: () => makeBootstrap({ channels: [chan(GEN, 'general'), chan(DM, null as unknown as string, { kind: 'dm', name: null, dmUserIds: [BOB, ME].sort() })] }),
      pages: { [DM]: { messages: [dmParent], hasMore: false } },
      route: (url) => (url === `/messages/${dmParent.id}/thread` ? { parent: dmParent, replies: [msg(2, { channelId: DM, parentId: dmParent.id })] } : undefined),
    });
    await boot(`/client/clubhack/${DM}`);
    await userEvent.click(await screen.findByRole('button', { name: '1 reply' }));
    expect(await screen.findByLabelText('Also send to conversation')).toBeTruthy();
  });
});

describe('Fix round 1', () => {
  it('a failed thread fetch shows an error with Retry that refetches', async () => {
    let fail = true;
    stubApi({
      pages: { [GEN]: { messages: [parent], hasMore: false } },
      route: (url) => {
        if (url !== `/messages/${parent.id}/thread`) return undefined;
        return fail ? new Response('{}', { status: 500 }) : thread();
      },
    });
    await boot();
    await userEvent.click(await screen.findByRole('button', { name: '2 replies' }));
    const panel = await screen.findByRole('complementary', { name: 'Thread' });
    expect((await within(panel).findByRole('alert')).textContent).toBe("Couldn't load this thread.");
    fail = false;
    await userEvent.click(within(panel).getByRole('button', { name: 'Retry' }));
    expect(await within(panel).findByText('first reply')).toBeTruthy();
    expect(within(panel).queryByRole('alert')).toBeNull();
  });

  it('the "Also send to" checkbox resets after a send', async () => {
    const { panel } = await openThread();
    await within(panel).findByText('first reply');
    const box = within(panel).getByLabelText('Also send to #general') as HTMLInputElement;
    await userEvent.click(box);
    await userEvent.type(within(panel).getByPlaceholderText('Reply…'), 'x{Enter}');
    expect(box.checked).toBe(false);
  });

  it('mark_thread_read is not sent while disconnected (it stays pending for the next connection)', async () => {
    const { ws, panel } = await openThread();
    await within(panel).findByText('second reply');
    await waitFor(() => expect(frames(ws).filter((f) => f.t === 'mark_thread_read')).toHaveLength(1));
    act(() => ws.serverClose(1006));
    act(() => ws.receive({ t: 'message.new', message: msg(4, { parentId: parent.id, body: 'while away' }) }));
    expect(frames(ws).filter((f) => f.t === 'mark_thread_read')).toHaveLength(1);
  });
});
