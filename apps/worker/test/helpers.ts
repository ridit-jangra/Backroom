import type { Deps } from '../src/app';

export function testDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    mailer: { sendMagicLink: async () => {} },
    now: () => 1_800_000_000_000,
    ...overrides,
  };
}
