import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { ORIGIN, TMP } from './paths';

export default defineConfig({
  testDir: './specs',
  // One server and one shared workspace: the chat flow is a single ordered story.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  globalSetup: './global-setup.ts',
  outputDir: path.join(TMP, 'test-results'),
  reporter: [['list']],
  use: {
    baseURL: ORIGIN,
    // Locally the system Chrome; CI installs Playwright's own chromium.
    ...(process.env.CI ? {} : { channel: 'chrome' }),
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
