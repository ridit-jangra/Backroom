import path from 'node:path';

// Playwright loads these files as CommonJS (the root package is not "type": "module").
const here = __dirname;

export const ROOT = path.resolve(here, '..');
export const TMP = path.join(here, '.tmp');
export const DIST = path.join(TMP, 'dist');
export const STATE = path.join(TMP, 'state');
export const SERVER_LOG = path.join(TMP, 'wrangler.log');
export const PID_FILE = path.join(TMP, 'server.pid');
export const WORKER_DIR = path.join(ROOT, 'apps', 'worker');
export const WEB_DIR = path.join(ROOT, 'apps', 'web');

/** Never 8787: the user's own dev server lives there. */
export const PORT = 8788;
export const INSPECTOR_PORT = 9231;
export const ORIGIN = `http://localhost:${PORT}`;
export const OWNER_EMAIL = 'owner@e2e.test';
export const WORKSPACE = 'clubhack';
