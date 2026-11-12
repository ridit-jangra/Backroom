import { TYPING_TTL_MS, type ChannelSummary, type Message } from '@backroom/protocol';
import { describe, expect, it } from 'vitest';
import type { PendingSend } from '../src/realtime/outbox';
import { initialChat, isViewing, lastSeenFor, reduce, type ChatEvent, type ChatState } from '../src/state/chat';

const ME = 'U'.repeat(26);
const OTHER = 'O'.repeat(26);

function msg(seq: number, o: Partial<Message> = {}): Message {
  return {
    id: `m${seq}`, channelId: 'c1', seq, userId: OTHER, parentId: null, body: `hi ${seq}`,
    alsoInChannel: false, createdAt: 1000 + seq, editedAt: null, deletedAt: null, replyCount: 0, lastReplyAt: null, ...o,
  };
}
function chan(id: string, o: Partial<ChannelSummary> = {}): ChannelSummary {
  return {
    id, name: id, kind: 'public', topic: null, createdBy: null, dmUserIds: null,
    lastSeq: 0, lastReadSeq: 0, unreadCount: 0, mentionCount: 0, ...o,
  };
}
function setup(channels: ChannelSummary[] = [chan('c1'), chan('c2')]): ChatState {
  let s = initialChat(ME);
  s = reduce(s, {
    t: 'local.bootstrap',
    bootstrap: {
      workspace: { id: 'w', slug: 'w', name: 'W' },
      me: { id: ME, email: 'a@b.c', displayName: 'Me', role: 'member' },
      channels, members: [],
    },
  }, 0);
  return s;
}
const pend = (clientId: string): PendingSend => ({
  clientId, channelId: 'c1', parentId: null, body: 'x', alsoInChannel: false, status: 'sending', attempts: 1, lastSentAt: 0,
});
const run = (s: ChatState, e: ChatEvent, now = 0) => reduce(s, e, now);
const newMsg = (s: ChatState, m: Message) => run(s, { t: 'message.new', message: m });

describe('chat reducer', () => {
  it('local.bootstrap sets me from bootstrap.me.id', () => {
    const s = reduce(initialChat(''), {
      t: 'local.bootstrap',
      bootstrap: { workspace: { id: 'w', slug: 'w', name: 'W' }, me: { id: ME, email: 'a@b.c', displayName: 'Me', role: 'member' }, channels: [], members: [] },
    }, 0);
    expect(s.me).toBe(ME);
  });
  it('new message in a background channel increments unread; in the viewed channel it does not', () => {
    let s = setup();
    s = newMsg(s, msg(1));
    expect(s.channels.c1!.unreadCount).toBe(1);
    expect(s.channels.c1!.lastSeq).toBe(1);
    expect(s.lastSeen.c1).toBe(1);
    s = run(s, { t: 'local.open', channelId: 'c1' });
    expect(s.channels.c1!.unreadCount).toBe(0);
    s = newMsg(s, msg(2));
    expect(s.channels.c1!.unreadCount).toBe(0);
    expect(isViewing(s, 'c1')).toBe(true);
    s = run(s, { t: 'local.focus', focused: false });
    s = newMsg(s, msg(3));
    expect(s.channels.c1!.unreadCount).toBe(1);
  });

  it('duplicate delivery (ack/catchup replay) does not double count', () => {
    let s = setup();
    s = newMsg(s, msg(1));
    s = run(s, { t: 'catchup', messages: [msg(1)], presence: [] });
    expect(s.channels.c1!.unreadCount).toBe(1);
  });

  it('mention of me, @channel and @here bump mentionCount; my own @channel does not', () => {
    let s = setup();
    s = newMsg(s, msg(1, { body: `yo <@${ME}>` }));
    s = newMsg(s, msg(2, { body: 'ping @channel' }));
    s = newMsg(s, msg(3, { body: 'ping @here' }));
    s = newMsg(s, msg(4, { body: 'nothing' }));
    expect(s.channels.c1!.mentionCount).toBe(3);
    expect(s.channels.c1!.unreadCount).toBe(4);
    s = newMsg(s, msg(5, { body: '@channel', userId: ME }));
    expect(s.channels.c1!.mentionCount).toBe(3);
    expect(s.channels.c1!.unreadCount).toBe(4);
  });

  it('replies do not bump unread unless alsoInChannel; they bump parent replyCount', () => {
    let s = setup();
    s = run(s, { t: 'local.history', channelId: 'c1', page: { messages: [msg(1)], hasMore: false }, mode: 'replace' });
    s = run(s, { t: 'local.thread', page: { parent: msg(1), replies: [] } });
    s = newMsg(s, msg(2, { parentId: 'm1' }));
    expect(s.channels.c1!.unreadCount).toBe(0);
    expect(s.windows.c1!.messages).toHaveLength(1);
    expect(s.windows.c1!.messages[0]!.replyCount).toBe(1);
    expect(s.windows.c1!.messages[0]!.lastReplyAt).toBe(1002);
    expect(s.threads.m1!.parent.replyCount).toBe(1);
    expect(s.threads.m1!.replies.map((m) => m.id)).toEqual(['m2']);
    s = newMsg(s, msg(3, { parentId: 'm1', alsoInChannel: true }));
    expect(s.channels.c1!.unreadCount).toBe(1);
    expect(s.windows.c1!.messages.map((m) => m.id)).toEqual(['m1', 'm3']);
    expect(s.threads.m1!.parent.replyCount).toBe(2);
  });

  it('read event clears counts when seq reaches lastSeq', () => {
    let s = setup();
    s = newMsg(s, msg(1, { body: '@channel' }));
    s = newMsg(s, msg(2));
    s = run(s, { t: 'read', channelId: 'c1', seq: 1 });
    expect(s.channels.c1).toMatchObject({ lastReadSeq: 1, unreadCount: 2, mentionCount: 1 });
    s = run(s, { t: 'read', channelId: 'c1', seq: 2 });
    expect(s.channels.c1).toMatchObject({ lastReadSeq: 2, unreadCount: 0, mentionCount: 0 });
    s = run(s, { t: 'read', channelId: 'c1', seq: 1 });
    expect(s.channels.c1!.lastReadSeq).toBe(2);
  });

  it('history prepend keeps order and dedupes by id', () => {
    let s = setup();
    s = run(s, { t: 'local.history', channelId: 'c1', page: { messages: [msg(5), msg(6)], hasMore: true }, mode: 'replace' });
    s = run(s, { t: 'local.history', channelId: 'c1', page: { messages: [msg(3), msg(4), msg(5)], hasMore: false }, mode: 'prepend' });
    expect(s.windows.c1!.messages.map((m) => m.seq)).toEqual([3, 4, 5, 6]);
    expect(s.windows.c1).toMatchObject({ hasOlder: false, loaded: true });
  });

  it('live messages join a loaded window only and edit/delete replace by id everywhere', () => {
    let s = setup();
    s = newMsg(s, msg(1));
    expect(s.windows.c1).toBeUndefined();
    s = run(s, { t: 'local.history', channelId: 'c1', page: { messages: [msg(1)], hasMore: false }, mode: 'replace' });
    s = run(s, { t: 'local.thread', page: { parent: msg(1), replies: [msg(2, { parentId: 'm1' })] } });
    s = run(s, { t: 'message.edit', message: msg(1, { body: 'edited', editedAt: 5 }) });
    expect(s.windows.c1!.messages[0]!.body).toBe('edited');
    expect(s.threads.m1!.parent.body).toBe('edited');
    s = run(s, { t: 'message.delete', message: msg(2, { parentId: 'm1', deletedAt: 9 }) });
    expect(s.threads.m1!.replies[0]!.deletedAt).toBe(9);
  });

  it('stale drops the channel window', () => {
    let s = setup();
    s = run(s, { t: 'local.history', channelId: 'c1', page: { messages: [msg(1)], hasMore: false }, mode: 'replace' });
    s = run(s, { t: 'local.history', channelId: 'c2', page: { messages: [msg(1, { channelId: 'c2', id: 'x' })], hasMore: false }, mode: 'replace' });
    s = run(s, { t: 'local.thread', page: { parent: msg(1), replies: [] } });
    s = run(s, { t: 'stale', channelId: 'c1' });
    expect(s.windows.c1).toBeUndefined();
    expect(s.windows.c2).toBeDefined();
    expect(s.threads.m1).toBeUndefined();
  });

  it('typing expires after 5 s on tick', () => {
    let s = setup();
    s = run(s, { t: 'typing', channelId: 'c1', userId: OTHER }, 1000);
    s = run(s, { t: 'typing', channelId: 'c1', userId: OTHER, parentId: 'm1' }, 1000);
    s = run(s, { t: 'typing', channelId: 'c1', userId: OTHER }, 3000);
    expect(s.typing).toHaveLength(2);
    expect(s.typing.find((x) => x.parentId === null)!.until).toBe(3000 + TYPING_TTL_MS);
    s = run(s, { t: 'local.tick', now: 1000 + TYPING_TTL_MS });
    expect(s.typing).toHaveLength(1);
    s = run(s, { t: 'local.tick', now: 3000 + TYPING_TTL_MS });
    expect(s.typing).toHaveLength(0);
  });

  it('membership removed deletes the channel and window; archived channel.update removes it', () => {
    let s = setup();
    s = run(s, { t: 'local.history', channelId: 'c1', page: { messages: [msg(1)], hasMore: false }, mode: 'replace' });
    s = run(s, { t: 'local.history', channelId: 'c2', page: { messages: [], hasMore: false }, mode: 'replace' });
    s = run(s, { t: 'membership', action: 'removed', channelId: 'c1' });
    expect(s.channels.c1).toBeUndefined();
    expect(s.windows.c1).toBeUndefined();
    s = run(s, { t: 'channel.update', channel: { id: 'c2', name: 'c2', kind: 'public', topic: null, archivedAt: 5 } });
    expect(s.channels.c2).toBeUndefined();
    expect(s.windows.c2).toBeUndefined();
  });

  it('channel.update merges name and topic', () => {
    let s = setup();
    s = run(s, { t: 'channel.update', channel: { id: 'c1', name: 'new', kind: 'public', topic: 'T', archivedAt: null } });
    expect(s.channels.c1).toMatchObject({ name: 'new', topic: 'T' });
  });

  it('membership added inserts an unknown channel from its summary', () => {
    let s = setup();
    s = run(s, { t: 'membership', action: 'added', channel: chan('c3', { lastSeq: 4, unreadCount: 4 }) });
    expect(s.channels.c3).toMatchObject({ lastSeq: 4, unreadCount: 4 });
  });

  it('membership added for a known channel merges metadata and keeps local counts (P2-R23)', () => {
    let s = setup();
    s = run(s, { t: 'local.history', channelId: 'c1', page: { messages: [msg(1)], hasMore: false }, mode: 'replace' });
    s = newMsg(s, msg(2, { body: '@channel' }));
    s = run(s, { t: 'read', channelId: 'c1', seq: 1 });
    const frame: ChatEvent = { t: 'membership', action: 'added', channel: chan('c1', { name: 'renamed', topic: 'x', lastSeq: 0, lastReadSeq: 0, unreadCount: 0, mentionCount: 0 }) };
    const after = run(s, frame);
    expect(after.channels.c1).toMatchObject({ name: 'renamed', topic: 'x', lastSeq: 2, lastReadSeq: 1, unreadCount: 1, mentionCount: 1 });
    expect(after.windows.c1!.messages).toHaveLength(2);
    expect(run(after, frame)).toBe(after);
    expect(run(after, frame).channels).toEqual(after.channels);
  });

  it('lastSeenFor uses the larger of bootstrap lastSeq and seen seq', () => {
    let s = setup([chan('c1', { lastSeq: 10 }), chan('c2', { lastSeq: 2 })]);
    s = { ...s, lastSeen: { c1: 4, c2: 7, gone: 3 } };
    expect(lastSeenFor(s)).toEqual({ c1: 10, c2: 7, gone: 3 });
  });

  it('presence, catchup presence, pending and connection are set', () => {
    let s = setup();
    s = run(s, { t: 'presence', userId: OTHER, state: 'away' });
    s = run(s, { t: 'catchup', messages: [], presence: [{ userId: 'z', state: 'active' }] });
    s = run(s, { t: 'local.connection', state: 'open' });
    expect(s.presence).toEqual({ z: 'active' }); // the catchup snapshot replaces the map
    expect(s.connection).toBe('open');
  });

  it('local.bootstrap replaces channels with fresh counts and keeps windows', () => {
    let s = setup();
    s = run(s, { t: 'local.history', channelId: 'c1', page: { messages: [msg(1)], hasMore: false }, mode: 'replace' });
    s = newMsg(s, msg(2));
    s = run(s, { t: 'local.bootstrap', bootstrap: { ...s.bootstrap!, channels: [chan('c1', { lastSeq: 2, unreadCount: 0 })] } });
    expect(s.channels.c2).toBeUndefined();
    expect(s.channels.c1!.unreadCount).toBe(0);
    expect(s.windows.c1).toBeDefined();
  });

  it('is pure and never mutates a deep-frozen state', () => {
    const deepFreeze = <T>(o: T): T => {
      if (o && typeof o === 'object' && !Object.isFrozen(o)) {
        Object.freeze(o);
        Object.values(o).forEach(deepFreeze);
      }
      return o;
    };
    let s = setup();
    s = run(s, { t: 'local.history', channelId: 'c1', page: { messages: [msg(1)], hasMore: true }, mode: 'replace' });
    s = run(s, { t: 'local.thread', page: { parent: msg(1), replies: [msg(2, { parentId: 'm1' })] } });
    s = run(s, { t: 'local.pending', pending: [pend('p1')] });
    s = run(s, { t: 'typing', channelId: 'c1', userId: OTHER }, 1);
    deepFreeze(s);
    const snap = JSON.stringify(s);
    const events: ChatEvent[] = [
      { t: 'message.new', message: msg(3, { body: '@here' }) },
      { t: 'message.new', message: msg(4, { parentId: 'm1', alsoInChannel: true }) },
      { t: 'message.edit', message: msg(1, { editedAt: 9 }) },
      { t: 'ack', clientId: 'p1', message: msg(5, { userId: ME }) },
      { t: 'read', channelId: 'c1', seq: 5 },
      { t: 'stale', channelId: 'c1' },
      { t: 'membership', action: 'removed', channelId: 'c1' },
      { t: 'local.history', channelId: 'c1', page: { messages: [msg(1)], hasMore: false }, mode: 'prepend' },
      { t: 'local.tick', now: 99999 },
    ];
    for (const e of events) run(s, e, 5);
    expect(JSON.stringify(s)).toBe(snap);
  });

  it('ack removes the pending item; own message renders once in either order', () => {
    const base = run(setup(), { t: 'local.history', channelId: 'c1', page: { messages: [], hasMore: false }, mode: 'replace' });
    const mine = msg(1, { userId: ME, id: 'mine' });
    const a = run(run(run(base, { t: 'local.pending', pending: [pend('p1')] }), { t: 'message.new', message: mine }), { t: 'ack', clientId: 'p1', message: mine });
    const b = run(run(run(base, { t: 'local.pending', pending: [pend('p1')] }), { t: 'ack', clientId: 'p1', message: mine }), { t: 'message.new', message: mine });
    for (const s of [a, b]) {
      expect(s.pending).toEqual([]);
      expect(s.windows.c1!.messages.map((m) => m.id)).toEqual(['mine']);
      expect(s.channels.c1!.unreadCount).toBe(0);
    }
  });

  it('nack marks the pending item failed', () => {
    const s = run(run(setup(), { t: 'local.pending', pending: [pend('p1'), pend('p2')] }), { t: 'nack', clientId: 'p1', code: 'forbidden' });
    expect(s.pending[0]).toMatchObject({ status: 'failed', error: 'forbidden' });
    expect(s.pending[1]!.status).toBe('sending');
  });

  it('a message already in a fetched page is not counted again when its live frame arrives', () => {
    let s = setup();
    s = run(s, { t: 'local.history', channelId: 'c1', page: { messages: [msg(1), msg(3, { parentId: 'm1', alsoInChannel: true, id: 'm3' })], hasMore: false }, mode: 'replace' });
    s = run(s, { t: 'local.thread', page: { parent: msg(1, { replyCount: 2 }), replies: [msg(2, { parentId: 'm1' }), msg(3, { parentId: 'm1', alsoInChannel: true })] } });
    s = newMsg(s, msg(2, { parentId: 'm1' }));
    s = newMsg(s, msg(3, { parentId: 'm1', alsoInChannel: true }));
    expect(s.threads.m1!.parent.replyCount).toBe(2);
    expect(s.windows.c1!.messages.find((m) => m.id === 'm1')!.replyCount).toBe(2);
    expect(s.channels.c1!.unreadCount).toBe(0);
  });

  it('local.bootstrap keeps the newest lastSeq and zeroes counts for the viewed channel', () => {
    let s = setup();
    s = run(s, { t: 'local.open', channelId: 'c1' });
    s = newMsg(s, msg(7));
    s = run(s, { t: 'local.bootstrap', bootstrap: { ...s.bootstrap!, channels: [chan('c1', { lastSeq: 5, unreadCount: 3, mentionCount: 1 }), chan('c2', { lastSeq: 1, unreadCount: 2 })] } });
    expect(s.channels.c1).toMatchObject({ lastSeq: 7, unreadCount: 0, mentionCount: 0 });
    expect(s.channels.c2!.unreadCount).toBe(2);
  });

  it('a replayed message does not revert a newer edit or delete', () => {
    let s = setup();
    s = run(s, { t: 'local.history', channelId: 'c1', page: { messages: [msg(1), msg(2)], hasMore: false }, mode: 'replace' });
    s = run(s, { t: 'message.edit', message: msg(1, { body: 'edited', editedAt: 50 }) });
    s = run(s, { t: 'message.delete', message: msg(2, { deletedAt: 60, body: '' }) });
    s = run(s, { t: 'catchup', messages: [msg(1), msg(2)], presence: [] });
    s = newMsg(s, msg(1));
    expect(s.windows.c1!.messages[0]).toMatchObject({ body: 'edited', editedAt: 50 });
    expect(s.windows.c1!.messages[1]!.deletedAt).toBe(60);
  });

  it('removed clears typing, open ids and lastSeen; stale keeps lastSeen', () => {
    let s = setup();
    s = newMsg(s, msg(1));
    s = run(s, { t: 'local.open', channelId: 'c1' });
    s = run(s, { t: 'local.openThread', parentId: 'm1' });
    s = run(s, { t: 'typing', channelId: 'c1', userId: OTHER }, 0);
    const st = run(s, { t: 'stale', channelId: 'c1' });
    expect(st.lastSeen.c1).toBe(1);
    expect(st.typing).toEqual([]);
    expect(st.openChannelId).toBe('c1');
    const r = run(s, { t: 'membership', action: 'removed', channelId: 'c1' });
    expect(r).toMatchObject({ openChannelId: null, openThreadId: null, typing: [] });
    expect(r.lastSeen.c1).toBeUndefined();
  });

  it('history replace keeps live messages newer than the page', () => {
    let s = setup();
    s = run(s, { t: 'local.history', channelId: 'c1', page: { messages: [msg(1)], hasMore: false }, mode: 'replace' });
    s = newMsg(s, msg(3));
    s = run(s, { t: 'local.history', channelId: 'c1', page: { messages: [msg(1), msg(2)], hasMore: false }, mode: 'replace' });
    expect(s.windows.c1!.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
  });
});

describe('catchup presence (final review)', () => {
  it('replaces the presence map with the snapshot: users absent from it are no longer active', () => {
    let s = setup();
    s = run(s, { t: 'presence', userId: OTHER, state: 'active' });
    s = run(s, { t: 'presence', userId: 'X'.repeat(26), state: 'away' });
    expect(s.presence[OTHER]).toBe('active');
    s = run(s, { t: 'catchup', messages: [], presence: [{ userId: ME, state: 'active' }] });
    expect(s.presence).toEqual({ [ME]: 'active' });
    s = run(s, { t: 'catchup', messages: [], presence: [] });
    expect(s.presence).toEqual({});
  });
});
