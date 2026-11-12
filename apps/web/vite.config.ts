import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // P3-R17: the generated emoji table is large; keep it out of the main chunk.
        manualChunks(id) {
          if (id.includes('/packages/emoji/src/generated/')) return 'emoji-data';
          return undefined;
        },
      },
    },
  },
  // Node's own (file-less, undefined) localStorage global would shadow jsdom's Storage.
  test: { environment: 'jsdom', execArgv: ['--no-experimental-webstorage'] },
});
