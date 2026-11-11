import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          // The workerd bundled with the pool's miniflare predates the production
          // compatibility_date in wrangler.jsonc; pin the newest date it supports.
          compatibilityDate: '2026-08-22',
          bindings: {
            OWNER_EMAIL: 'owner@test.dev',
            APP_ORIGIN: 'https://app.test',
            RESEND_API_KEY: 'test',
            TEST_MIGRATIONS: migrations,
          },
        },
      }),
    ],
    test: { setupFiles: ['./test/setup.ts'] },
  };
});
