import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { HubFrame, parseClientFrame, parseHubFrame } from '../src';

const GN = '01JCLUBHACK0000000000000GN';

describe('ws frames', () => {
  it('accepts seed IDs and a valid send', () => {
    const r = parseClientFrame(JSON.stringify({ t: 'send', clientId: 'c-12345678', channelId: GN, body: 'hi' }));
    expect(r.ok).toBe(true);
  });
  it('body of 40,000 chars passes, 40,001 is too_long with clientId', () => {
    expect(parseClientFrame(JSON.stringify({ t: 'send', clientId: 'c-12345678', channelId: GN, body: 'a'.repeat(40_000) })).ok).toBe(true);
    expect(parseClientFrame(JSON.stringify({ t: 'send', clientId: 'c-12345678', channelId: GN, body: 'a'.repeat(40_001) }))).toEqual({
      ok: false,
      clientId: 'c-12345678',
      code: 'too_long',
    });
  });
  it('whitespace-only body is invalid', () => {
    expect(parseClientFrame(JSON.stringify({ t: 'send', clientId: 'c-12345678', channelId: GN, body: ' \n ' }))).toEqual({
      ok: false,
      clientId: 'c-12345678',
      code: 'invalid',
    });
  });
  it('rejects bad JSON and unknown types without clientId', () => {
    expect(parseClientFrame('{nope')).toEqual({ ok: false, code: 'invalid' });
    expect(parseClientFrame('{"t":"react","messageId":"x"}').ok).toBe(false);
  });
  it('parseHubFrame accepts both membership shapes and rejects junk', () => {
    expect(parseHubFrame(JSON.stringify({ t: 'membership', action: 'removed', channelId: GN }))).not.toBeNull();
    expect(parseHubFrame('{"t":"message.new"}')).toBeNull();
    expect(parseHubFrame('nope')).toBeNull();
  });
  it("parseHubFrame accepts nack code 'rate_limited' (Phase 6)", () => {
    expect(parseHubFrame(JSON.stringify({ t: 'nack', clientId: 'c-1-xxxxxx', code: 'rate_limited' }))).toEqual({
      t: 'nack',
      clientId: 'c-1-xxxxxx',
      code: 'rate_limited',
    });
  });
  it('parseHubFrame returns null for an unknown hub frame type (old clients ignore new frames)', () => {
    expect(parseHubFrame('{"t":"future_hub_thing"}')).toBeNull();
    expect(parseHubFrame('{"t":"future_hub_thing","x":1}')).toBeNull();
  });
  it('parses hello, ping, activity and rejects oversize lastSeen', () => {
    expect(parseClientFrame(JSON.stringify({ t: 'hello', lastSeen: { [GN]: 3 } })).ok).toBe(true);
    expect(parseClientFrame('{"t":"ping"}').ok).toBe(true);
    expect(parseClientFrame('{"t":"activity"}').ok).toBe(true);
    const big = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`01H${String(i).padStart(23, '0')}`, 1]));
    expect(parseClientFrame(JSON.stringify({ t: 'hello', lastSeen: big })).ok).toBe(false);
  });
  it('react frame parses; bad emoji is invalid with clientId', () => {
    expect(parseClientFrame(JSON.stringify({ t: 'react', messageId: GN, emoji: 'wave::skin-tone-3', on: true })).ok).toBe(true);
    expect(parseClientFrame(JSON.stringify({ t: 'react', messageId: GN, emoji: '<b>', on: true, clientId: 'c-12345678' })))
      .toEqual({ ok: false, clientId: 'c-12345678', code: 'invalid' });
  });
  it('wire compatibility both ways', () => {
    const old = { id: GN, channelId: GN, seq: 1, userId: GN, parentId: null, body: 'x', alsoInChannel: false,
      createdAt: 1, editedAt: null, deletedAt: null, replyCount: 0, lastReplyAt: null };
    expect(parseHubFrame(JSON.stringify({ t: 'message.new', message: old }))).not.toBeNull();
    const withR = parseHubFrame(JSON.stringify({ t: 'message.new', message: { ...old, reactions: [{ emoji: '+1', userIds: [GN] }] } }));
    expect(withR && withR.t === 'message.new' && withR.message.reactions).toEqual([{ emoji: '+1', userIds: [GN] }]);
    expect(parseHubFrame(JSON.stringify({ t: 'reaction', channelId: GN, messageId: GN, emoji: '+1', userId: GN, on: true }))).not.toBeNull();
    expect(parseHubFrame(JSON.stringify({ t: 'emoji.update', added: [], removed: [GN] }))).not.toBeNull();
    expect(parseClientFrame('{"t":"future_thing"}')).toEqual({ ok: false, code: 'invalid' });
  });
});

describe('files on the wire', () => {
  it('send body may be blank only with files; at most 10 files', () => {
    const base = { t: 'send', clientId: 'c-12345678', channelId: GN };
    expect(parseClientFrame(JSON.stringify({ ...base, body: '', fileIds: [GN] })).ok).toBe(true);
    expect(parseClientFrame(JSON.stringify({ ...base, body: '  ' }))).toEqual({ ok: false, clientId: 'c-12345678', code: 'invalid' });
    expect(parseClientFrame(JSON.stringify({ ...base, body: '', fileIds: [] })).ok).toBe(false);
    expect(parseClientFrame(JSON.stringify({ ...base, body: 'x', fileIds: Array(11).fill(GN) })).ok).toBe(false);
    expect(parseClientFrame(JSON.stringify({ t: 'edit', messageId: GN, body: ' ' })).ok).toBe(false);
  });
  it('files on messages are optional both ways', () => {
    const old = { id: GN, channelId: GN, seq: 1, userId: GN, parentId: null, body: 'x', alsoInChannel: false,
      createdAt: 1, editedAt: null, deletedAt: null, replyCount: 0, lastReplyAt: null };
    const f = { id: GN, name: 'a.png', mime: 'image/png', size: 3, width: 1, height: 1, hasThumb: false };
    const r = parseHubFrame(JSON.stringify({ t: 'message.new', message: { ...old, files: [f] } }));
    expect(r && r.t === 'message.new' && r.message.files).toEqual([f]);
    expect(parseHubFrame(JSON.stringify({ t: 'message.new', message: old }))).not.toBeNull();
  });
});

describe('thread.counts frame', () => {
  const counts = { t: 'thread.counts', channelId: GN, parentId: GN, replyCount: 2, lastReplyAt: 5 };
  it('parses with a null or numeric lastReplyAt and rejects bad shapes', () => {
    expect(parseHubFrame(JSON.stringify(counts))).toEqual(counts);
    expect(parseHubFrame(JSON.stringify({ ...counts, lastReplyAt: null }))).toEqual({ ...counts, lastReplyAt: null });
    expect(parseHubFrame(JSON.stringify({ ...counts, replyCount: -1 }))).toBeNull();
    expect(parseHubFrame(JSON.stringify({ ...counts, replyCount: 1.5 }))).toBeNull();
    expect(parseHubFrame(JSON.stringify({ ...counts, parentId: undefined }))).toBeNull();
  });
  it('an old client (the union without it) ignores the frame without throwing, as it does any unknown type', () => {
    const oldUnion = z.union(HubFrame.options.filter((o) => (o.shape.t as { value: string }).value !== 'thread.counts') as never);
    expect(oldUnion.safeParse(counts).success).toBe(false);
    expect(parseHubFrame(JSON.stringify({ t: 'some.future.frame', x: 1 }))).toBeNull();
    // Unknown extra fields on an existing frame are stripped, not rejected.
    const msg = { id: GN, channelId: GN, seq: 1, userId: GN, parentId: null, body: '', alsoInChannel: false,
      createdAt: 1, editedAt: null, deletedAt: 2, replyCount: 0, lastReplyAt: null };
    expect(parseHubFrame(JSON.stringify({ t: 'message.delete', message: msg, extra: 1 }))).toEqual({ t: 'message.delete', message: msg });
  });
});
