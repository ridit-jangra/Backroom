import { describe, expect, it } from 'vitest';
import type { Message } from '@backroom/protocol';
import { notifyTargets } from '../src/messaging/notify';
import type { Audience } from '../src/messaging/store';

const msg = (over: Partial<Message> = {}): Message => ({
  id: 'm1',
  channelId: 'c1',
  seq: 1,
  userId: 'author',
  parentId: null,
  body: 'hi',
  alsoInChannel: false,
  createdAt: 1,
  editedAt: null,
  deletedAt: null,
  replyCount: 0,
  lastReplyAt: null,
  ...over,
});

const aud = (over: Partial<Audience> = {}, notify: Record<string, 'all' | 'mentions' | 'none'> = {}): Audience => ({
  kind: 'public',
  members: ['author', 'a', 'b', 'c'].map((userId) => ({ userId, notify: notify[userId] ?? 'mentions' })),
  followers: [],
  mentions: { userIds: [], channel: false, here: false },
  ...over,
});

const all = () => true;

describe('notifyTargets', () => {
  it('dm notifies every other participant', () => {
    expect(notifyTargets(aud({ kind: 'dm' }), msg(), all)).toEqual([
      { userId: 'a', kind: 'dm' },
      { userId: 'b', kind: 'dm' },
      { userId: 'c', kind: 'dm' },
    ]);
  });

  it('direct mention beats @channel and ignores notify none', () => {
    const a = aud({ mentions: { userIds: ['a'], channel: true, here: false } }, { a: 'none', b: 'none' });
    expect(notifyTargets(a, msg(), all)).toEqual([
      { userId: 'a', kind: 'mention' },
      { userId: 'c', kind: 'channel' },
    ]);
  });

  it('@channel respects notify none', () => {
    const a = aud({ mentions: { userIds: [], channel: true, here: false } }, { b: 'none' });
    expect(notifyTargets(a, msg(), all).map((t) => t.userId)).toEqual(['a', 'c']);
  });

  it('@here only reaches active members', () => {
    const a = aud({ mentions: { userIds: [], channel: false, here: true } }, { c: 'none' });
    expect(notifyTargets(a, msg(), (u) => u === 'a' || u === 'c')).toEqual([{ userId: 'a', kind: 'here' }]);
  });

  it('followers get thread replies, author never notified', () => {
    const a = aud({ followers: ['author', 'b'] });
    expect(notifyTargets(a, msg({ parentId: 'root' }), all)).toEqual([{ userId: 'b', kind: 'thread' }]);
    expect(notifyTargets(a, msg(), all)).toEqual([]);
  });

  it('notify all gets top-level messages only', () => {
    const a = aud({}, { a: 'all' });
    expect(notifyTargets(a, msg(), all)).toEqual([{ userId: 'a', kind: 'all' }]);
    expect(notifyTargets(a, msg({ parentId: 'root' }), all)).toEqual([]);
  });
});
