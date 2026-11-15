import type { ChannelSummary, Message } from '@backroom/protocol';
import { describe, expect, it } from 'vitest';
import { initialChat, liveMessages, reduce, type ChatEvent, type ChatState } from '../src/state/chat';

const ME = 'U'.repeat(26);
const OTHER = 'O'.repeat(26);

function msg(seq: number, o: Partial<Message> = {}): Message {
  return {
    id: `m${seq}`, channelId: 'c1', seq, userId: OTHER, parentId: null, body: `hi ${seq}`,
    alsoInChannel: false, createdAt: 1000 + seq, editedAt: null, deletedAt: null, replyCount: 0, lastReplyAt: null, ...o,
  };
}
const tomb = (m: Message, at = 99): Message => ({ ...m, body: '', editedAt: at, deletedAt: at, replyCount: 0, lastReplyAt: null });
function chan(id: string): ChannelSummary {
  return { id, name: id, kind: 'public', topic: null, createdBy: null, dmUserIds: null, lastSeq: 0, lastReadSeq: 0, unreadCount: 0, mentionCount: 0 };
}
const run = (s: ChatState, e: ChatEvent) => reduce(s, e, 0);
function setup(): ChatState {
  return run(initialChat(ME), {
    t: 'local.bootstrap',
    bootstrap: {
      workspace: { id: 'w', slug: 'w', name: 'W' },
      me: { id: ME, email: 'a@b.c', displayName: 'Me', role: 'member' },
      channels: [chan('c1'), chan('c2')], members: [],
    },
  });
}

const starter = msg(1, { replyCount: 3, lastReplyAt: 1010 });
const r1 = msg(2, { parentId: 'm1', alsoInChannel: true });
const r2 = msg(3, { parentId: 'm1' });
const r3 = msg(4, { parentId: 'm1' });

/** Channel window with the starter and an "also in channel" reply, thread page open. */
function withThread(): ChatState {
  let s = setup();
  s = run(s, { t: 'local.history', channelId: 'c1', page: { messages: [starter, r1], hasMore: false }, mode: 'replace' });
  s = run(s, { t: 'local.open', channelId: 'c1' });
  s = run(s, { t: 'local.thread', page: { parent: starter, replies: [r1, r2, r3] } });
  s = run(s, { t: 'local.openThread', parentId: 'm1' });
  return s;
}

describe('liveMessages selector', () => {
  it('drops tombstones and returns the same array when nothing is deleted', () => {
    const a = msg(1);
    const list = [a, tomb(msg(2)), msg(3)];
    expect(liveMessages(list).map((m) => m.id)).toEqual(['m1', 'm3']);
    const all = [a, msg(3)];
    expect(liveMessages(all)).toBe(all);
  });
});

describe('deleted messages in state', () => {
  it('a reply tombstone stays in state (seq continuity) and wins over a replayed live copy', () => {
    let s = withThread();
    s = run(s, { t: 'message.delete', message: tomb(r2) });
    expect(s.threads.m1!.replies.find((m) => m.id === 'm3')!.deletedAt).toBe(99);
    s = run(s, { t: 'message.new', message: r2 });
    expect(s.threads.m1!.replies.find((m) => m.id === 'm3')!.deletedAt).toBe(99);
    expect(s.threads.m1!.replies.find((m) => m.id === 'm3')!.body).toBe('');
  });

  it('thread.counts sets the starter counters exactly, including going down', () => {
    let s = withThread();
    s = run(s, { t: 'thread.counts', channelId: 'c1', parentId: 'm1', replyCount: 2, lastReplyAt: 1004 });
    expect(s.windows.c1!.messages[0]!.replyCount).toBe(2);
    expect(s.threads.m1!.parent.replyCount).toBe(2);
    expect(s.threads.m1!.parent.lastReplyAt).toBe(1004);
    s = run(s, { t: 'thread.counts', channelId: 'c1', parentId: 'm1', replyCount: 0, lastReplyAt: null });
    expect(s.windows.c1!.messages[0]!.replyCount).toBe(0);
    expect(s.windows.c1!.messages[0]!.lastReplyAt).toBeNull();
    expect(s.threads.m1!.parent.replyCount).toBe(0);
  });

  it('an older reply replayed after thread.counts does not raise the counters back', () => {
    let s = withThread();
    s = run(s, { t: 'message.delete', message: tomb(r3) });
    s = run(s, { t: 'thread.counts', channelId: 'c1', parentId: 'm1', replyCount: 2, lastReplyAt: 1003 });
    // Out-of-order delivery: the original frame of the deleted reply, a catch-up replay and an ack.
    s = run(s, { t: 'message.new', message: r3 });
    s = run(s, { t: 'catchup', messages: [r3, r2], presence: [] });
    expect(s.windows.c1!.messages[0]!.replyCount).toBe(2);
    expect(s.threads.m1!.parent.replyCount).toBe(2);
    expect(s.threads.m1!.replies.find((m) => m.id === 'm4')!.deletedAt).toBe(99);
  });

  it('a genuinely new reply after thread.counts still bumps the count', () => {
    let s = withThread();
    s = run(s, { t: 'thread.counts', channelId: 'c1', parentId: 'm1', replyCount: 1, lastReplyAt: 1002 });
    s = run(s, { t: 'message.new', message: msg(9, { parentId: 'm1', createdAt: 5000 }) });
    expect(s.windows.c1!.messages[0]!.replyCount).toBe(2);
    expect(s.windows.c1!.messages[0]!.lastReplyAt).toBe(5000);
  });

  it('thread.counts for an unknown starter changes nothing', () => {
    const s = setup();
    expect(run(s, { t: 'thread.counts', channelId: 'c1', parentId: 'nope', replyCount: 1, lastReplyAt: 1 })).toBe(s);
  });

  it('a starter tombstone frame drops all its replies and closes the open thread', () => {
    let s = withThread();
    s = run(s, { t: 'message.delete', message: tomb(starter) });
    expect(s.threads.m1).toBeUndefined();
    expect(s.openThreadId).toBeNull();
    const ids = s.windows.c1!.messages.map((m) => m.id);
    expect(ids).toEqual(['m1']);
    expect(liveMessages(s.windows.c1!.messages)).toEqual([]);
    expect(s.windows.c1!.messages[0]!.deletedAt).toBe(99);
  });

  it('replies of a deleted starter that arrive later are not rendered or counted unread', () => {
    let s = withThread();
    s = run(s, { t: 'message.delete', message: tomb(starter) });
    const before = s.channels.c1!.unreadCount;
    s = run(s, { t: 'message.new', message: msg(7, { parentId: 'm1', alsoInChannel: true }) });
    expect(s.windows.c1!.messages.map((m) => m.id)).toEqual(['m1']);
    expect(s.channels.c1!.unreadCount).toBe(before);
    expect(s.lastSeen.c1).toBe(7);
  });

  it('deleting a different thread leaves this one open', () => {
    let s = withThread();
    s = run(s, { t: 'message.delete', message: tomb(msg(20, { id: 'other' })) });
    expect(s.openThreadId).toBe('m1');
    expect(s.threads.m1).toBeDefined();
  });

  it('a history page with a starter tombstone drops that starter\'s replies and closes its thread', () => {
    let s = withThread();
    s = run(s, { t: 'local.history', channelId: 'c1', page: { messages: [tomb(starter), msg(5)], hasMore: false }, mode: 'replace' });
    expect(s.threads.m1).toBeUndefined();
    expect(s.openThreadId).toBeNull();
    expect(s.windows.c1!.messages.map((m) => m.id)).toEqual(['m1', 'm5']);
  });

  it('a prepended history page with a tombstone removes the live copy', () => {
    let s = setup();
    s = run(s, { t: 'local.history', channelId: 'c1', page: { messages: [msg(5), msg(6)], hasMore: true }, mode: 'replace' });
    s = run(s, { t: 'local.history', channelId: 'c1', page: { messages: [tomb(msg(5))], hasMore: false }, mode: 'prepend' });
    expect(liveMessages(s.windows.c1!.messages).map((m) => m.id)).toEqual(['m6']);
  });

  it('catch-up with tombstones (starter and replies) removes live copies and drops the thread', () => {
    let s = withThread();
    s = run(s, { t: 'catchup', messages: [tomb(r1), tomb(r2), tomb(starter)], presence: [] });
    expect(s.openThreadId).toBeNull();
    expect(s.threads.m1).toBeUndefined();
    expect(liveMessages(s.windows.c1!.messages)).toEqual([]);
  });

  it('a thread page whose parent is deleted closes the thread instead of storing it', () => {
    let s = setup();
    s = run(s, { t: 'local.open', channelId: 'c1' });
    s = run(s, { t: 'local.openThread', parentId: 'm1' });
    s = run(s, { t: 'local.thread', page: { parent: tomb(starter), replies: [] } });
    expect(s.openThreadId).toBeNull();
    expect(s.threads.m1).toBeUndefined();
  });

  it('a thread page replaces held replies, so a reply deleted while away disappears', () => {
    let s = withThread();
    s = run(s, { t: 'local.thread', page: { parent: { ...starter, replyCount: 2 }, replies: [r1, tomb(r2), r3] } });
    expect(liveMessages(s.threads.m1!.replies).map((m) => m.id)).toEqual(['m2', 'm4']);
    expect(s.threads.m1!.parent.replyCount).toBe(2);
  });
});

describe('reconnect', () => {
  it('local.reconnected drops other channels\' cached windows and threads but keeps the open ones', () => {
    let s = withThread();
    s = run(s, { t: 'local.history', channelId: 'c2', page: { messages: [msg(1, { id: 'x1', channelId: 'c2' })], hasMore: false }, mode: 'replace' });
    s = run(s, { t: 'local.thread', page: { parent: msg(1, { id: 'x1', channelId: 'c2', replyCount: 1 }), replies: [msg(2, { id: 'x2', channelId: 'c2', parentId: 'x1' })] } });
    s = run(s, { t: 'local.reconnected' });
    expect(s.windows.c2).toBeUndefined();
    expect(s.threads.x1).toBeUndefined();
    expect(s.windows.c1).toBeDefined();
    expect(s.threads.m1).toBeDefined();
    expect(s.openThreadId).toBe('m1');
  });

  it('local.reconnected keeps unread counts, lastSeen and read pointers', () => {
    let s = setup();
    s = run(s, { t: 'message.new', message: msg(1, { channelId: 'c2', id: 'q1' }) });
    const before = s;
    s = run(s, { t: 'local.reconnected' });
    expect(s.channels).toEqual(before.channels);
    expect(s.lastSeen).toEqual(before.lastSeen);
  });
});

describe('fix round 1: stale REST pages versus live counters', () => {
  const live = (s: ChatState) => s.windows.c1!.messages.find((m) => m.id === 'm1')!;

  it('a page fetched BEFORE a thread.counts frame does not overwrite the fresher counters (lower)', () => {
    let s = withThread();
    const start = s.countClock; // fetch starts here
    s = run(s, { t: 'thread.counts', channelId: 'c1', parentId: 'm1', replyCount: 1, lastReplyAt: 1002 });
    s = run(s, { t: 'local.history', channelId: 'c1', page: { messages: [{ ...starter, body: 'fresh body' }, r1], hasMore: false }, mode: 'replace', startMark: start });
    expect(live(s).replyCount).toBe(1);
    expect(live(s).lastReplyAt).toBe(1002);
    expect(live(s).body).toBe('fresh body'); // every other field still comes from the page
    s = run(s, { t: 'local.thread', page: { parent: starter, replies: [r1, r2, r3] }, startMark: start });
    expect(s.threads.m1!.parent.replyCount).toBe(1);
    expect(s.windows.c1!.messages.find((m) => m.id === 'm1')!.replyCount).toBe(1);
  });

  it('a page fetched before a live reply bump does not lower the bumped count (higher)', () => {
    let s = withThread();
    const start = s.countClock;
    s = run(s, { t: 'message.new', message: msg(9, { parentId: 'm1', createdAt: 5000 }) });
    expect(live(s).replyCount).toBe(4);
    s = run(s, { t: 'local.history', channelId: 'c1', page: { messages: [starter], hasMore: false }, mode: 'replace', startMark: start });
    expect(live(s).replyCount).toBe(4);
    expect(live(s).lastReplyAt).toBe(5000);
  });

  it('a page fetched AFTER the frame is authoritative', () => {
    let s = withThread();
    s = run(s, { t: 'thread.counts', channelId: 'c1', parentId: 'm1', replyCount: 1, lastReplyAt: 1002 });
    const start = s.countClock;
    s = run(s, { t: 'local.history', channelId: 'c1', page: { messages: [{ ...starter, replyCount: 5 }], hasMore: false }, mode: 'replace', startMark: start });
    expect(live(s).replyCount).toBe(5);
  });

  it('pages without a startMark behave as before', () => {
    let s = withThread();
    s = run(s, { t: 'thread.counts', channelId: 'c1', parentId: 'm1', replyCount: 1, lastReplyAt: 1002 });
    s = run(s, { t: 'local.history', channelId: 'c1', page: { messages: [{ ...starter, replyCount: 5 }], hasMore: false }, mode: 'replace' });
    expect(live(s).replyCount).toBe(5);
  });
});

describe('fix round 1: deletedParents across a reconnect', () => {
  it('is cleared on reconnect (except the open thread) and a still-deleted starter is dropped again by the refetch', () => {
    let s = withThread();
    s = run(s, { t: 'message.delete', message: tomb(msg(30, { id: 'other' })) });
    s = run(s, { t: 'message.delete', message: tomb(starter) });
    expect(Object.keys(s.deletedParents).sort()).toEqual(['m1', 'other']);
    s = run(s, { t: 'local.openThread', parentId: 'm1' });
    s = run(s, { t: 'local.reconnected' });
    expect(Object.keys(s.deletedParents)).toEqual(['m1']);
    s = run(s, { t: 'local.openThread', parentId: null });
    s = run(s, { t: 'local.reconnected' });
    expect(s.deletedParents).toEqual({});
    s = run(s, { t: 'local.history', channelId: 'c1', page: { messages: [tomb(starter), msg(5, { parentId: 'm1', alsoInChannel: true })], hasMore: false }, mode: 'replace' });
    expect(s.deletedParents.m1).toBe(true);
  });
});
