// Bundles src/index.ts into dist/server.mjs (one self-contained ESM file for Node 26) and copies the worker's SQL
// migrations next to it. Usage: node build.mjs [--outdir <dir>]   (default: dist)
// Bundling is required: Node's type stripping cannot run the worker's TypeScript (parameter properties).
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { nodePlatformRedirect } from './src/platform/aliases.ts';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const at = args.indexOf('--outdir');
const outdir = resolve(at >= 0 && args[at + 1] ? args[at + 1] : join(here, 'dist'));

/** `cloudflare:workers` → the Durable Object shim; the hub's runtime seam → its Node version (same as the tests). */
const nodePlatform = {
  name: 'backroom-node-platform',
  setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$|platform(\.ts|\.js)?$/ }, (a) => {
      const path = nodePlatformRedirect(a.path, a.importer || undefined);
      return path ? { path } : undefined;
    });
  },
};

await build({
  entryPoints: [join(here, 'src/index.ts')],
  outfile: join(outdir, 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node26',
  // ws's optional native helpers are loaded in a try/catch; they are not installed.
  external: ['bufferutil', 'utf-8-validate'],
  // CommonJS dependencies (ws) call require() for Node builtins.
  banner: { js: "import { createRequire as __backroomCreateRequire } from 'node:module';\nconst require = __backroomCreateRequire(import.meta.url);" },
  plugins: [nodePlatform],
  legalComments: 'none',
  logLevel: 'warning',
});

const migrationsSrc = join(here, '../worker/migrations');
const migrationsOut = join(outdir, 'migrations');
rmSync(migrationsOut, { recursive: true, force: true });
mkdirSync(migrationsOut, { recursive: true });
const sql = readdirSync(migrationsSrc).filter((n) => n.endsWith('.sql'));
for (const n of sql) copyFileSync(join(migrationsSrc, n), join(migrationsOut, n));
console.log(`built ${join(outdir, 'server.mjs')} (+ ${sql.length} migrations)`);
