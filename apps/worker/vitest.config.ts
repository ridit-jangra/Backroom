import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

export default defineConfig(async () => {
  const migrations = await readD1Migrations('migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          // Both blob backends are bound here; the file/emoji suites run once per backend with only one of them
          // visible to the app (test/helpers.ts backendEnv). Production binds only BLOBS (wrangler.jsonc).
          kvNamespaces: ['BLOBS'],
          r2Buckets: ['BUCKET'],
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
