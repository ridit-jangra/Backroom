import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Bootstrap, HubFrame } from '@backroom/protocol';
import { notificationText, plainText, showNotification } from '../src/notifications';
import { App } from '../src/App';
import { FakeWebSocket } from './fakeSocket';

const id = (p: string) => p.padEnd(26, '0');
const GEN = id('01JGENERAL');
const ME = id('01JME');
const BOB = id('01JBOB');

type Notify = Extract<HubFrame, { t: 'notify' }>;
const frame: Notify = {
  t: 'notify', kind: 'mention', channelId: GEN, messageId: id('01JMSG'), parentId: null, fromUserId: BOB,
  preview: `hey <@${ME}>`,
};

function stubNotification(permission: NotificationPermission) {
  const created: { title: string; opts: NotificationOptions; self: { onclick: (() => void) | null } }[] = [];
  class FakeNotification {
    static permission = permission;
    static requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
    onclick: (() => void) | null = null;
    constructor(title: string, opts: NotificationOptions) {
      created.push({ title, opts, self: this });
    }
  }
  vi.stubGlobal('Notification', FakeNotification);
  return { created, Fake: FakeNotification };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  history.replaceState(null, '', '/');
});

describe('notifications', () => {
  it('suppressed while viewing the channel', () => {
    const { created } = stubNotification('granted');
    const onClick = vi.fn();
    expect(showNotification(frame, { viewing: true, title: '#general', body: 'x', onClick })).toBe(false);
    expect(created).toHaveLength(0);
  });

  it('not shown without permission or without the Notification API', () => {
    const { created } = stubNotification('denied');
    expect(showNotification(frame, { viewing: false, title: 't', body: 'b', onClick: () => {} })).toBe(false);
    expect(created).toHaveLength(0);
    vi.stubGlobal('Notification', undefined);
    expect(showNotification(frame, { viewing: false, title: 't', body: 'b', onClick: () => {} })).toBe(false);
  });

  it('shown when not viewing and permission granted, with tag = messageId', () => {
    const { created } = stubNotification('granted');
    const onClick = vi.fn();
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
    expect(showNotification(frame, { viewing: false, title: '#general', body: 'hey @Me', onClick })).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0]!.title).toBe('#general');
    expect(created[0]!.opts).toEqual({ body: 'hey @Me', tag: frame.messageId });
    created[0]!.self.onclick!();
    expect(focus).toHaveBeenCalled();
    expect(onClick).toHaveBeenCalled();
  });

  it('titles and bodies: dm → sender, others → #channel or DM names; mentions as @Name', () => {
    const members = [
      { id: ME, displayName: 'Me', role: 'member' as const, avatarKey: null },
      { id: BOB, displayName: 'Bob', role: 'member' as const, avatarKey: null },
    ];
    const channels = {
      [GEN]: { id: GEN, kind: 'public' as const, name: 'general', topic: null, createdBy: null, dmUserIds: null, lastSeq: 0, lastReadSeq: 0, unreadCount: 0, mentionCount: 0 },
    };
    expect(notificationText(frame, { channels, members, me: ME })).toEqual({ title: '#general', body: 'hey @Me' });
    expect(notificationText({ ...frame, kind: 'dm', preview: 'yo <@ZZZZZZZZZZZZZZZZZZZZZZZZZZ>' }, { channels, members, me: ME })).toEqual({
      title: 'Bob',
      body: 'yo @unknown',
    });
  });

  it('permission is requested only on click', async () => {
    const { Fake } = stubNotification('default');
    FakeWebSocket.reset();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const bootstrap: Bootstrap = {
      workspace: { id: 'w', slug: 'clubhack', name: 'Club Hack' },
      me: { id: ME, email: 'me@example.com', displayName: 'Me', role: 'member' },
      channels: [{ id: GEN, kind: 'public', name: 'general', topic: null, createdBy: ME, dmUserIds: null, lastSeq: 0, lastReadSeq: 0, unreadCount: 0, mentionCount: 0 }],
      members: [{ id: ME, displayName: 'Me', role: 'member', avatarKey: null }],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        /\/bootstrap(\?|$)/.test(url)
          ? new Response(JSON.stringify(bootstrap), { status: 200 })
          : new Response(JSON.stringify({ messages: [], hasMore: false }), { status: 200 }),
      ),
    );
    history.replaceState(null, '', `/client/clubhack/${GEN}`);
    render(createElement(App));
    await waitFor(() => expect(FakeWebSocket.instances.length).toBe(1));
    act(() => FakeWebSocket.instances[0]!.open());
    const button = await screen.findByRole('button', { name: 'Enable notifications' });
    expect(Fake.requestPermission).not.toHaveBeenCalled();
    Fake.permission = 'granted';
    await userEvent.click(button);
    expect(Fake.requestPermission).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Enable notifications' })).toBeNull());
  });
});

describe('plainText emoji (P3-R4)', () => {
  it('keeps shortcodes as written', () => {
    expect(plainText(':wave: hi', [])).toBe(':wave: hi');
  });
});
