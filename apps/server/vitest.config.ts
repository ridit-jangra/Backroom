import { defineConfig } from 'vitest/config';

// Plain Node (no Workers pool): the server runs the worker's application code on node:sqlite and the filesystem.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // test/fs-blobs-fd.test.ts forces garbage collection (a collected open FileHandle crashes Node 26).
    execArgv: ['--expose-gc'],
  },
});
