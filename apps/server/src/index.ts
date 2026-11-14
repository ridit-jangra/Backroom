/**
 * Backroom on Node: the worker's Hono app and WorkspaceHub behind a plain HTTP server, on SQLite and the filesystem.
 * Built into dist/server.mjs by build.mjs (esbuild); run with `npm start -w apps/server` or `node dist/server.mjs`.
 *
 * Startup: config → data dir → sweep blob leftovers → open DB → migrations → FixedLengthStream polyfill → blob
 * store, hub namespace, env → listen → one-line summary. `--maintenance` runs the daily maintenance once and exits.
 */
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../worker/src/app';
import { pickMailer } from '../../worker/src/auth/mailer';
import type { Env } from '../../worker/src/env';
import worker, { WorkspaceHub } from '../../worker/src/index';
import { fileMaxBytes } from '../../worker/src/lib/quota';
import { ConfigError, type ServerConfig, loadConfig } from './config';
import { runMaintenance, startDailySchedule, withMaintenanceLock } from './cron';
import { createHttpServer, createRequestHandler } from './http';
import { acquireLock } from './lockfile';
import { errorFields, log } from './log';
import { type NodeD1Database, createD1 } from './platform/d1';
import { DurableObjectNamespaceShim } from './platform/do-runtime';
import { installFixedLengthStream } from './platform/fixed-length-stream';
import { createFsBlobStore, sweepBlobDir } from './platform/fs-blobs';
import { applyMigrations, pendingMigrations } from './platform/migrate';
import { createUpgradeBridge } from './platform/ws-bridge';
import { createShutdown } from './shutdown';
import { createStaticSite } from './static';
import { createWorkTracker } from './work';

const here = dirname(fileURLToPath(import.meta.url));

/** dist/migrations (copied by the build), or the worker's own folder when running from source. */
function migrationsDir(): string {
  const bundled = join(here, 'migrations');
  return existsSync(bundled) ? bundled : resolve(here, '../../worker/migrations');
}

function fail(message: string): never {
  process.stderr.write(`backroom: ${message}\n`);
  process.exit(1);
}

function readConfig(): ServerConfig {
  try {
    const { config, warnings } = loadConfig(process.env, process.argv.slice(2), {
      cwd: process.cwd(),
      defaultWebDist: resolve(here, '../../web/dist'),
    });
    for (const w of warnings) process.stderr.write(`${w}\n`);
    return config;
  } catch (e) {
    if (e instanceof ConfigError) {
      fail(`configuration error:\n${e.message
        .split('\n')
        .map((l) => `  - ${l}`)
        .join('\n')}\nSee apps/server/.env.example for every setting.`);
    }
    throw e;
  }
}

function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function checkpointAndClose(db: NodeD1Database): void {
  db.sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
}

async function main(): Promise<void> {
  const config = readConfig();

  const blobDir = join(config.dataDir, 'blobs');
  const dbPath = join(config.dataDir, 'backroom.sqlite');
  const firstRun = !existsSync(dbPath);
  let swept = { tempFiles: 0, orphanData: 0, danglingSidecars: 0 };
  let db: NodeD1Database;
  let applied: string[] = [];

  if (config.maintenance) {
    // A maintenance run may share the data dir with a live server: it never takes the server lock, never sweeps
    // the blob directory (that would remove the server's in-flight uploads) and never migrates.
    if (!existsSync(dbPath)) fail(`no database at ${dbPath}: start the server once (it creates and migrates it) before running --maintenance`);
    db = createD1(dbPath);
    const pending = await pendingMigrations(db, migrationsDir());
    if (pending.length > 0) {
      db.close();
      fail(`${pending.length} database migration(s) are pending (${pending.join(', ')}): start the server, which applies them, before running --maintenance`);
    }
  } else {
    ensurePrivateDir(config.dataDir);
    ensurePrivateDir(blobDir);
    // One server per data directory: a second one would sweep the first one's uploads and race its writes.
    const serverLock = await acquireLock(join(config.dataDir, 'server.lock'));
    if (!serverLock) {
      fail(`another Backroom server (see ${join(config.dataDir, 'server.lock')}) is using this DATA_DIR; stop it first, or use a different DATA_DIR`);
    }
    process.once('exit', () => serverLock.releaseSync());

    // Crash leftovers (temp files, unreferenced data files) go before anything can write a blob.
    swept = await sweepBlobDir(blobDir);

    db = createD1(dbPath);
    try {
      applied = await applyMigrations(db, migrationsDir());
    } catch (e) {
      db.close();
      // The message names the migration file and SQLite's error; it holds no user data.
      fail(e instanceof Error ? e.message : 'migrations failed');
    }
  }

  installFixedLengthStream();

  const env = {} as Env;
  const hubs = new DurableObjectNamespaceShim(WorkspaceHub, () => env);
  const site = config.maintenance ? null : await createStaticSite(config.webDist).catch((e: Error) => fail(e.message));
  Object.assign(env, {
    DB: db,
    BLOB_STORE: createFsBlobStore(blobDir),
    HUB: hubs,
    ASSETS: {
      async fetch(input: RequestInfo | URL, init?: RequestInit) {
        const r = new Request(input, init);
        return (await site?.serve(r)) ?? new Response('Not found', { status: 404 });
      },
    },
    APP_ORIGIN: config.appOrigin,
    OWNER_EMAIL: config.ownerEmail,
    RESEND_API_KEY: config.resendApiKey,
    EMAIL_FROM: config.emailFrom,
    ...(config.filesQuotaBytes !== null ? { FILES_QUOTA_BYTES: config.filesQuotaBytes } : {}),
    ...(config.fileMaxBytes !== null ? { FILE_MAX_BYTES: config.fileMaxBytes } : {}),
  });

  const maintenance = () =>
    withMaintenanceLock(
      join(config.dataDir, 'maintenance.lock'),
      async () => {
        const t0 = Date.now();
        log('info', 'maintenance_started');
        await runMaintenance(worker.scheduled as never, env);
        log('info', 'maintenance_done', { ms: Date.now() - t0 });
      },
      log,
    );

  if (config.maintenance) {
    let code = 0;
    try {
      if ((await maintenance()) === 'locked') log('info', 'maintenance_not_run', { reason: 'another run holds the lock' });
    } catch (e) {
      log('error', 'maintenance_failed', errorFields(e));
      code = 1;
    }
    // No TRUNCATE checkpoint here: the live server owns the WAL.
    db.close();
    process.exit(code);
  }

  const work = createWorkTracker(log);
  const app = createApp({ mailer: pickMailer(env), now: Date.now });
  const handler = createRequestHandler({
    app,
    env,
    ctx: work.ctx,
    site: site!,
    checkDb: () => db.sqlite.prepare('SELECT 1 FROM d1_migrations LIMIT 1').get(),
    maxBodyBytes: fileMaxBytes(env),
    log,
  });
  const bridge = createUpgradeBridge();
  const http = createHttpServer({
    handler,
    upgradeHandler: async (r) => app.fetch(r, env, work.ctx),
    bridge,
    appOrigin: config.appOrigin,
    trustedProxyHeader: config.trustedProxyHeader,
    log,
  });
  // Longer than a reverse proxy's usual idle timeout, so the proxy never reuses a connection we are closing.
  http.server.keepAliveTimeout = 65_000;

  await new Promise<void>((resolveListen) => {
    const onListenError = (e: NodeJS.ErrnoException) => {
      checkpointAndClose(db);
      fail(`cannot listen on ${config.host}:${config.port} (${e.code ?? e.name})`);
    };
    http.server.once('error', onListenError);
    http.server.listen(config.port, config.host, () => {
      // Startup failures only: a later server error is logged, never a reason to close the database and exit.
      http.server.off('error', onListenError);
      http.server.on('error', (e) => log('error', 'server_error', errorFields(e)));
      resolveListen();
    });
  });

  const schedule = startDailySchedule({ run: maintenance, log });

  const shutdown = createShutdown(
    {
      stopScheduler: () => schedule.stop(),
      stopAccepting: () => {
        http.server.close();
        http.server.closeIdleConnections();
      },
      closeHubSockets: () => hubs.closeAll(1001, 'server shutting down'),
      waitForSockets: async (ms) => {
        const until = Date.now() + ms;
        while (http.upgraded.size > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
      },
      closeBridge: () => bridge.close(),
      disposeHubs: () => hubs.dispose(),
      drainHubs: () => hubs.drain(),
      drainWork: () => work.drain(),
      drainMaintenance: async () => {
        await schedule.running();
      },
      drainRequests: async () => {
        await http.idle();
        http.server.closeIdleConnections();
      },
      forceCloseConnections: () => {
        http.server.closeAllConnections();
        for (const s of http.upgraded) s.destroy();
      },
      closeDb: () => checkpointAndClose(db),
    },
    { exit: (code) => process.exit(code), log },
  );
  process.on('SIGTERM', () => shutdown.onSignal('SIGTERM'));
  process.on('SIGINT', () => shutdown.onSignal('SIGINT'));
  process.on('uncaughtException', (e) => {
    log('error', 'uncaught_exception', errorFields(e));
    shutdown.onSignal('uncaughtException', 1);
  });
  process.on('unhandledRejection', (e) => log('error', 'unhandled_rejection', errorFields(e)));

  const address = http.server.address();
  log('info', 'server_started', {
    port: typeof address === 'object' && address ? address.port : config.port,
    host: config.host,
    dataDir: config.dataDir,
    firstRun,
    migrationsApplied: applied.length,
    mailer: config.mailer,
    trustedProxyHeader: config.trustedProxyHeader,
    webDist: config.webDist,
    blobLeftoversRemoved: swept.tempFiles + swept.orphanData + swept.danglingSidecars,
    nextMaintenance: schedule.nextAt()?.toISOString() ?? null,
  });
}

main().catch((e: unknown) => {
  log('error', 'startup_failed', errorFields(e));
  process.exit(1);
});
