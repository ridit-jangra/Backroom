/** Source of the `<@ID>` user-mention token matcher. Build with `new RegExp(USER_MENTION_RE.source, 'g')`. */
export const USER_MENTION_RE = /<@([0-9A-Z]{26})>/;

/** Source of the @channel / @here matcher (shared with the client tokenizer). Build with flag 'g'. */
export const BROADCAST_RE = /(?<![A-Za-z0-9_@</])@(channel|here)(?![A-Za-z0-9_-])/;

import { maskCode } from './code';

export const MAX_USER_MENTIONS = 50;

export type ParsedMentions = { userIds: string[]; channel: boolean; here: boolean };

export type BroadcastMatch = { index: number; length: number; kind: 'channel' | 'here' };

export function findBroadcasts(body: string): BroadcastMatch[] {
  const out: BroadcastMatch[] = [];
  for (const m of body.matchAll(new RegExp(BROADCAST_RE.source, 'g'))) {
    out.push({ index: m.index, length: m[0].length, kind: m[1] as 'channel' | 'here' });
  }
  return out;
}

export function extractMentions(raw: string): ParsedMentions {
  const body = maskCode(raw); // `@x` inside code never notifies
  const seen = new Set<string>();
  for (const m of body.matchAll(new RegExp(USER_MENTION_RE.source, 'g'))) {
    if (seen.size >= MAX_USER_MENTIONS) break;
    seen.add(m[1]!);
  }
  const b = findBroadcasts(body);
  return {
    userIds: [...seen],
    channel: b.some((x) => x.kind === 'channel'),
    here: b.some((x) => x.kind === 'here'),
  };
}
