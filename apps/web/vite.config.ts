import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Node's own (file-less, undefined) localStorage global would shadow jsdom's Storage.
  test: { environment: 'jsdom', execArgv: ['--no-experimental-webstorage'] },
});
