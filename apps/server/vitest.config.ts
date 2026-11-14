import { defineConfig } from 'vitest/config';
import { nodePlatformRedirect } from './src/platform/aliases';

// Plain Node (no Workers pool): the server runs the worker's application code on node:sqlite and the filesystem.
export default defineConfig({
  plugins: [
    {
      // cloudflare:workers -> the Durable Object shim; the hub's runtime seam -> its Node version.
      name: 'backroom-node-platform',
      enforce: 'pre',
      resolveId: (source, importer) => nodePlatformRedirect(source, importer),
    },
  ],
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // test/fs-blobs-fd.test.ts forces garbage collection (a collected open FileHandle crashes Node 26).
    execArgv: ['--expose-gc'],
  },
});
