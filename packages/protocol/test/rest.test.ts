import { describe, it, expect } from 'vitest';
import { AuthStartBody, DesktopExchangeBody, InviteCreateBody } from '../src';

describe('AuthStartBody', () => {
  it('normalizes email', () => {
    expect(AuthStartBody.parse({ email: '  Alice@Example.COM ' }).email).toBe('alice@example.com');
  });
  it('rejects non-email', () => {
    expect(AuthStartBody.safeParse({ email: 'nope' }).success).toBe(false);
  });
});
describe('InviteCreateBody', () => {
  it('applies defaults', () => {
    expect(InviteCreateBody.parse({})).toEqual({ maxUses: 50, expiresInDays: 14 });
  });
});

describe('desktop auth bodies', () => {
  const ch = 'A'.repeat(43);
  it('AuthStartBody accepts an optional 43-char base64url desktopChallenge', () => {
    expect(AuthStartBody.parse({ email: 'a@b.co', desktopChallenge: ch }).desktopChallenge).toBe(ch);
    expect(AuthStartBody.safeParse({ email: 'a@b.co', desktopChallenge: 'short' }).success).toBe(false);
    expect(AuthStartBody.safeParse({ email: 'a@b.co', desktopChallenge: '+'.repeat(43) }).success).toBe(false);
  });
  it('DesktopExchangeBody validates code and verifier', () => {
    expect(DesktopExchangeBody.safeParse({ code: 'x'.repeat(10), verifier: ch }).success).toBe(true);
    expect(DesktopExchangeBody.safeParse({ code: 'short', verifier: ch }).success).toBe(false);
    expect(DesktopExchangeBody.safeParse({ code: 'x'.repeat(10), verifier: 'bad' }).success).toBe(false);
  });
});
