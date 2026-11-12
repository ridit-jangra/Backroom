import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ChannelListing } from '@backroom/protocol';
import { FakeWebSocket } from './fakeSocket';
import { ANN, BOB, GEN, ME, RAND, boot, chan, err, id, makeBootstrap, stubApi } from './harness';

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

const DESIGN = id('01JDESIGN');
const listing = (o: Partial<ChannelListing> & { id: string; name: string }): ChannelListing => ({
  kind: 'public', topic: null, archivedAt: null, memberCount: 3, isMember: false, ...o,
});

describe('Channel browser', () => {
  it('browse lists channels and Join posts then navigates', async () => {
    // After the join, bootstrap includes the channel.
    let joined = false;
    const posted = stubApi({
      bootstrap: () => makeBootstrap({ channels: [chan(GEN, 'general'), chan(RAND, 'random'), ...(joined ? [chan(DESIGN, 'design')] : [])] }),
      route: (url, init) => {
        if (url === '/w/clubhack/channels' && init?.method === 'GET')
          return { channels: [listing({ id: GEN, name: 'general', isMember: true, memberCount: 5 }), listing({ id: DESIGN, name: 'design', memberCount: 2 })] };
        if (url === `/channels/${DESIGN}/join`) {
          joined = true;
          return { channel: chan(DESIGN, 'design') };
        }
        return undefined;
      },
    });
    await boot();
    await userEvent.click(await screen.findByRole('button', { name: 'Browse channels' }));
    const dlg = await screen.findByRole('dialog', { name: 'Browse channels' });
    const list = await within(dlg).findByRole('list', { name: 'Channels' });
    expect(within(list).getByText('5 members')).toBeTruthy();
    expect(within(list).getByText('2 members')).toBeTruthy();
    expect(within(list).getByRole('button', { name: 'Open' })).toBeTruthy();
    await userEvent.click(within(list).getByRole('button', { name: 'Join' }));
    await waitFor(() => expect(location.pathname).toBe(`/client/clubhack/${DESIGN}`));
    expect(posted.find((p) => p.url === `/channels/${DESIGN}/join`)?.method).toBe('POST');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByRole('button', { name: '#design' })).toBeTruthy();
  });

  it('create posts lowercase name and private flag; 409 shows the taken message', async () => {
    let status = 409;
    const posted = stubApi({
      route: (url, init) => {
        if (url === '/w/clubhack/channels' && init?.method === 'GET') return { channels: [] };
        if (url === '/w/clubhack/channels' && init?.method === 'POST')
          return status === 409 ? err(409, 'name_taken') : new Response(JSON.stringify({ channel: chan(DESIGN, 'design') }), { status: 201 });
        return undefined;
      },
    });
    await boot();
    await userEvent.click(await screen.findByRole('button', { name: 'Browse channels' }));
    const dlg = await screen.findByRole('dialog', { name: 'Browse channels' });
    await userEvent.type(within(dlg).getByLabelText('Name'), 'Design');
    await userEvent.type(within(dlg).getByLabelText('Topic'), 'pixels');
    await userEvent.click(within(dlg).getByLabelText('Private'));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Create' }));
    expect((await within(dlg).findByRole('alert')).textContent).toBe('That name is already taken.');
    expect(posted[0]).toMatchObject({ url: '/w/clubhack/channels', body: { name: 'design', private: true, topic: 'pixels' } });
    status = 201;
    await userEvent.click(within(dlg).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(location.pathname).toBe(`/client/clubhack/${DESIGN}`));
  });

  it('create shows the format message on 400', async () => {
    stubApi({
      route: (url, init) => {
        if (url === '/w/clubhack/channels' && init?.method === 'GET') return { channels: [] };
        if (init?.method === 'POST') return err(400, 'invalid');
        return undefined;
      },
    });
    await boot();
    await userEvent.click(await screen.findByRole('button', { name: 'Browse channels' }));
    const dlg = await screen.findByRole('dialog', { name: 'Browse channels' });
    await userEvent.type(within(dlg).getByLabelText('Name'), 'has space');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Create' }));
    expect((await within(dlg).findByRole('alert')).textContent).toBe('Use lowercase letters, numbers, - and _ (max 80).');
  });
});

describe('Channel settings', () => {
  it('settings hides Archive for non-managers and Leave for general', async () => {
    stubApi();
    await boot(`/client/clubhack/${RAND}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Channel settings' }));
    let dlg = await screen.findByRole('dialog', { name: 'Channel settings' });
    expect(within(dlg).queryByRole('button', { name: 'Archive channel' })).toBeNull();
    expect(within(dlg).queryByLabelText('Name')).toBeNull();
    expect(within(dlg).getByLabelText('Topic')).toBeTruthy();
    expect(within(dlg).getByRole('button', { name: 'Leave channel' })).toBeTruthy();
    await userEvent.click(within(dlg).getByRole('button', { name: 'Close' }));

    // #general: no Leave and no Archive even for an admin.
    cleanup();
    FakeWebSocket.reset();
    stubApi({ bootstrap: () => makeBootstrap({}, 'admin') });
    await boot(`/client/clubhack/${GEN}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Channel settings' }));
    dlg = await screen.findByRole('dialog', { name: 'Channel settings' });
    expect(within(dlg).queryByRole('button', { name: 'Leave channel' })).toBeNull();
    expect(within(dlg).queryByRole('button', { name: 'Archive channel' })).toBeNull();
  });

  it('a manager can save the topic, rename, archive and leave navigates to general', async () => {
    const posted = stubApi({
      bootstrap: () => makeBootstrap({ channels: [chan(GEN, 'general'), chan(RAND, 'random', { createdBy: ME })] }),
      route: (url) => (url.startsWith('/channels/') && !url.includes('/messages') ? { channel: {}, ok: true } : undefined),
    });
    vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    await boot(`/client/clubhack/${RAND}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Channel settings' }));
    let dlg = await screen.findByRole('dialog', { name: 'Channel settings' });
    await userEvent.type(within(dlg).getByLabelText('Topic'), 'new topic');
    await userEvent.click(within(dlg).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(posted[0]).toMatchObject({ url: `/channels/${RAND}`, method: 'PATCH', body: { topic: 'new topic' } });

    await userEvent.click(screen.getByRole('button', { name: 'Channel settings' }));
    dlg = await screen.findByRole('dialog', { name: 'Channel settings' });
    await userEvent.click(within(dlg).getByRole('button', { name: 'Archive channel' }));
    await waitFor(() => expect(location.pathname).toBe(`/client/clubhack/${GEN}`));
    expect(posted[1]).toMatchObject({ url: `/channels/${RAND}`, method: 'PATCH', body: { archived: true } });
  });

  it('leave posts and navigates to general; the header shows the topic live', async () => {
    const posted = stubApi({
      route: (url) => (url === `/channels/${RAND}/leave` ? { ok: true } : undefined),
    });
    const ws = await boot(`/client/clubhack/${RAND}`);
    act(() => ws.receive({ t: 'channel.update', channel: { id: RAND, name: 'random', kind: 'public', topic: 'fun times', archivedAt: null } }));
    expect(await screen.findByText('fun times')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Channel settings' }));
    const dlg = await screen.findByRole('dialog', { name: 'Channel settings' });
    await userEvent.click(within(dlg).getByRole('button', { name: 'Leave channel' }));
    await waitFor(() => expect(location.pathname).toBe(`/client/clubhack/${GEN}`));
    expect(posted[0]).toMatchObject({ url: `/channels/${RAND}/leave`, method: 'POST' });
  });
});

describe('Direct messages', () => {
  const DM = id('01JDMBOB');

  it('new DM posts selected userIds and navigates to the returned channel', async () => {
    let made = false;
    const posted = stubApi({
      bootstrap: () =>
        makeBootstrap({ channels: [chan(GEN, 'general'), ...(made ? [chan(DM, null as unknown as string, { kind: 'dm', name: null, dmUserIds: [ANN, BOB] })] : [])] }),
      route: (url, init) => {
        if (url === '/w/clubhack/dms' && init?.method === 'POST') {
          made = true;
          return new Response(JSON.stringify({ channel: chan(DM, null as unknown as string, { kind: 'dm', name: null, dmUserIds: [ANN, BOB] }) }), { status: 201 });
        }
        return undefined;
      },
    });
    await boot();
    await userEvent.click(await screen.findByRole('button', { name: 'New message' }));
    const dlg = await screen.findByRole('dialog', { name: 'New message' });
    expect(within(dlg).queryByLabelText('Me')).toBeNull();
    expect((within(dlg).getByRole('button', { name: 'Open' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(within(dlg).getByLabelText('Bob'));
    await userEvent.click(within(dlg).getByLabelText('Ann'));
    await userEvent.click(within(dlg).getByRole('button', { name: 'Open' }));
    await waitFor(() => expect(location.pathname).toBe(`/client/clubhack/${DM}`));
    expect(posted[0]).toMatchObject({ url: '/w/clubhack/dms', body: { userIds: [BOB, ANN] } });
  });

  it("DM appears in the sidebar labelled with the other member's name", async () => {
    stubApi();
    const ws = await boot();
    await screen.findByRole('button', { name: '#general' });
    expect(screen.queryByRole('navigation', { name: 'Direct messages' })).toBeNull();
    act(() =>
      ws.receive({ t: 'membership', action: 'added', channel: chan(DM, null as unknown as string, { kind: 'dm', name: null, dmUserIds: [BOB, ME].sort(), createdBy: BOB }) }),
    );
    const nav = await screen.findByRole('navigation', { name: 'Direct messages' });
    expect(within(nav).getByRole('button', { name: 'Bob' })).toBeTruthy();
  });
});
