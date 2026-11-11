import { describe, it, expect } from 'vitest';
import { AuthStartBody, InviteCreateBody } from '../src';

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
