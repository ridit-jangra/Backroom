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
  it('parses hello, ping, activity and rejects oversize lastSeen', () => {
    expect(parseClientFrame(JSON.stringify({ t: 'hello', lastSeen: { [GN]: 3 } })).ok).toBe(true);
    expect(parseClientFrame('{"t":"ping"}').ok).toBe(true);
    expect(parseClientFrame('{"t":"activity"}').ok).toBe(true);
    const big = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`01H${String(i).padStart(23, '0')}`, 1]));
    expect(parseClientFrame(JSON.stringify({ t: 'hello', lastSeen: big })).ok).toBe(false);
  });
});
