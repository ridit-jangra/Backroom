import path from 'node:path';

// Playwright loads these files as CommonJS (the root package is not "type": "module").
const here = __dirname;

export const ROOT = path.resolve(here, '..');
export const TMP = path.join(here, '.tmp');
/** The web build the server serves (never apps/web/dist). */
export const DIST = path.join(TMP, 'dist');
/** The server bundle (server.mjs + migrations/), built by apps/server/build.mjs --outdir. */
export const SERVER_DIST = path.join(TMP, 'server');
export const SERVER_BUNDLE = path.join(SERVER_DIST, 'server.mjs');
/** A fresh DATA_DIR per run (database, blobs, lock files). */
export const DATA_DIR = path.join(TMP, 'data');
export const SERVER_LOG = path.join(TMP, 'server.log');
export const PID_FILE = path.join(TMP, 'server.pid');
export const SERVER_DIR = path.join(ROOT, 'apps', 'server');
export const WEB_DIR = path.join(ROOT, 'apps', 'web');

/** Never 8787: the user's own dev server lives there. */
export const PORT = 8788;
export const ORIGIN = `http://localhost:${PORT}`;
export const OWNER_EMAIL = 'owner@e2e.test';
export const WORKSPACE = 'clubhack';
