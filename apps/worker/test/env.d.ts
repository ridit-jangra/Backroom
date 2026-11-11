import type { D1Migration } from 'cloudflare:test';

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      ASSETS: Fetcher;
      RESEND_API_KEY: string;
      OWNER_EMAIL: string;
      APP_ORIGIN: string;
      EMAIL_FROM: string;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
