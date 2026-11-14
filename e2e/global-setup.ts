import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import {
  DIST,
  INSPECTOR_PORT,
  ORIGIN,
  OWNER_EMAIL,
  PID_FILE,
  PORT,
  SERVER_LOG,
  STATE,
  TMP,
  WEB_DIR,
  WORKER_DIR,
} from './paths';
import { stopServer } from './server';

/**
 * apps/worker/.dev.vars holds a REAL Resend key. This override selects the console mailer, so
 * no email ever leaves the machine and the magic links land in the server log instead.
 */
const MAILER_OVERRIDE = 'RESEND_API_KEY:dev';

export function serverArgs(): string[] {
  return [
    'wrangler',
    'dev',
    '--port',
    String(PORT),
    '--inspector-port',
    String(INSPECTOR_PORT),
    '--assets',
    DIST,
    '--var',
    `APP_ORIGIN:${ORIGIN}`,
    '--var',
    MAILER_OVERRIDE,
    '--var',
    `OWNER_EMAIL:${OWNER_EMAIL}`,
    '--persist-to',
    STATE,
    '--show-interactive-dev-session=false',
  ];
}

async function healthy(): Promise<boolean> {
  try {
    const res = await fetch(`${ORIGIN}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

function run(cmd: string, args: string[], cwd: string, what: string) {
  try {
    execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer };
    const tail = `${err.stdout?.toString() ?? ''}\n${err.stderr?.toString() ?? ''}`.split('\n').slice(-30).join('\n');
    throw new Error(`e2e setup: ${what} failed\n${tail}`);
  }
}

export default async function globalSetup() {
  // Something already answers on 8788 (a leftover run or a smoke test): refuse instead of
  // killing a process this run did not start.
  if (await healthy()) throw new Error(`e2e setup: port ${PORT} is already serving; stop that server first.`);

  const args = serverArgs();
  const v = args.indexOf(MAILER_OVERRIDE);
  if (v < 1 || args[v - 1] !== '--var') {
    throw new Error('e2e setup: refusing to start wrangler without --var RESEND_API_KEY:dev (real emails would be sent).');
  }

  fs.mkdirSync(TMP, { recursive: true });
  fs.rmSync(STATE, { recursive: true, force: true });
  fs.rmSync(SERVER_LOG, { force: true });

  // Never build into apps/web/dist: the user's dev server on 8787 serves it.
  run('npm', ['run', 'build', '--', '--outDir', DIST, '--emptyOutDir'], WEB_DIR, 'web build');
  run('npx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', STATE], WORKER_DIR, 'migrations');

  const log = fs.openSync(SERVER_LOG, 'a');
  // detached: the server leads its own process group, so teardown stops only what we started.
  const child = spawn('npx', args, {
    cwd: WORKER_DIR,
    detached: true,
    stdio: ['ignore', log, log],
    env: process.env,
  });
  fs.closeSync(log);
  if (child.pid === undefined) throw new Error('e2e setup: could not start wrangler dev');
  fs.writeFileSync(PID_FILE, String(child.pid));
  child.unref();

  let exited = false;
  child.on('exit', () => (exited = true));
  const deadline = Date.now() + 90_000;
  while (!(await healthy())) {
    if (exited || Date.now() > deadline) {
      await stopServer();
      throw new Error(`e2e setup: wrangler dev did not become healthy (log: ${SERVER_LOG})`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  return async () => {
    await stopServer();
  };
}
