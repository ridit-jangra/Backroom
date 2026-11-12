import { describe, expect, it } from 'vitest';
import { parseClientFrame, parseHubFrame } from '../src';

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
