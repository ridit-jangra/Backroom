/**
 * Module redirects that run the worker's code on Node, shared by the test config (vitest.config.ts) and the
 * build (Task 3's esbuild plugin): `cloudflare:workers` becomes the runtime shim, and the hub's runtime seam
 * (apps/worker/src/hub/platform.ts) becomes hub-platform.ts. Plain erasable TypeScript, so Node can load it as is.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const CLOUDFLARE_WORKERS_SHIM = join(here, 'cloudflare-workers-shim.ts');
export const WORKER_HUB_PLATFORM = resolve(here, '../../../worker/src/hub/platform.ts');
export const NODE_HUB_PLATFORM = join(here, 'hub-platform.ts');

/** The file an import should load on Node instead, or null to resolve it normally. */
export function nodePlatformRedirect(specifier: string, importer: string | undefined): string | null {
  if (specifier === 'cloudflare:workers') return CLOUDFLARE_WORKERS_SHIM;
  if (importer && specifier.startsWith('.')) {
    const target = resolve(dirname(importer.split('?')[0]!), specifier);
    if (target === WORKER_HUB_PLATFORM || `${target}.ts` === WORKER_HUB_PLATFORM) return NODE_HUB_PLATFORM;
  }
  return null;
}
