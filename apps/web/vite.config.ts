import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const target = 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/auth': target,
      '/me': target,
      '/w': target,
      '/invites': target,
    },
  },
  test: { environment: 'jsdom' },
});
