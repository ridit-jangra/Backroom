import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLOUDFLARE_WORKERS_SHIM, NODE_HUB_PLATFORM, WORKER_HUB_PLATFORM, nodePlatformRedirect } from '../src/platform/aliases';

const hubDir = WORKER_HUB_PLATFORM.replace(/platform\.ts$/, '');
const fromHub = join(hubDir, 'WorkspaceHub.ts');

describe('nodePlatformRedirect', () => {
  it('maps cloudflare:workers to the shim', () => {
    expect(nodePlatformRedirect('cloudflare:workers', fromHub)).toBe(CLOUDFLARE_WORKERS_SHIM);
  });

  it.each(['./platform', './platform.ts', './platform.js'])('redirects the hub seam imported as %s', (spec) => {
    expect(nodePlatformRedirect(spec, fromHub)).toBe(NODE_HUB_PLATFORM);
  });

  it('redirects the seam from another directory and with a query on the importer', () => {
    expect(nodePlatformRedirect('../hub/platform.js', join(hubDir, '../messaging/x.ts?v=1'))).toBe(NODE_HUB_PLATFORM);
  });

  it.each(['./platforms', './platform.mjs', './other', 'platform'])('leaves %s alone', (spec) => {
    expect(nodePlatformRedirect(spec, fromHub)).toBeNull();
  });

  it('leaves a ./platform import elsewhere alone', () => {
    expect(nodePlatformRedirect('./platform', join(hubDir, '../files/routes.ts'))).toBeNull();
  });
});
