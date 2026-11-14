import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import {
  DATA_DIR,
  DIST,
  ORIGIN,
  OWNER_EMAIL,
  PID_FILE,
  PORT,
  SERVER_BUNDLE,
  SERVER_DIR,
  SERVER_DIST,
  SERVER_LOG,
  TMP,
  WEB_DIR,
} from './paths';
import { stopServer } from './server';

/**
 * The environment of the Node server under test. RESEND_API_KEY=dev selects the console mailer, so no email ever
 * leaves the machine and the magic links land in the server log instead. Only the variables the server needs (plus
 * PATH/HOME) are passed: nothing from the caller's environment can switch the mailer or the data directory.
 */
export function serverEnv(): Record<string, string> {
  const env: Record<string, string> = {
    APP_ORIGIN: ORIGIN,
    OWNER_EMAIL,
    RESEND_API_KEY: 'dev',
    DATA_DIR,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    WEB_DIST: DIST,
  };
  for (const k of ['PATH', 'HOME', 'TZ', 'LANG']) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
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

/** The server's one-line startup summary must confirm the console mailer; anything else stops the run. */
function startupMailer(): string | null {
  let text = '';
  try {
    text = fs.readFileSync(SERVER_LOG, 'utf8');
  } catch {
    return null;
  }
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const o = JSON.parse(line) as { code?: string; mailer?: string };
      if (o.code === 'server_started') return o.mailer ?? 'unknown';
    } catch {
      /* not a log line */
    }
  }
  return null;
}

export default async function globalSetup() {
  // Something already answers on 8788 (a leftover run or a smoke test): refuse instead of
  // killing a process this run did not start.
  if (await healthy()) throw new Error(`e2e setup: port ${PORT} is already serving; stop that server first.`);

  const env = serverEnv();
  if (env.RESEND_API_KEY !== 'dev') {
    throw new Error('e2e setup: refusing to start the server without RESEND_API_KEY=dev (real emails would be sent).');
  }

  fs.mkdirSync(TMP, { recursive: true });
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.rmSync(SERVER_LOG, { force: true });

  // Never build into apps/web/dist: the user's dev server on 8787 serves it.
  run('npm', ['run', 'build', '--', '--outDir', DIST, '--emptyOutDir'], WEB_DIR, 'web build');
  run('npm', ['run', 'build', '--', '--outdir', SERVER_DIST], SERVER_DIR, 'server build');

  const log = fs.openSync(SERVER_LOG, 'a');
  // detached: the server leads its own process group, so teardown stops only what we started.
  const child = spawn(process.execPath, [SERVER_BUNDLE], {
    cwd: TMP,
    detached: true,
    stdio: ['ignore', log, log],
    env,
  });
  fs.closeSync(log);
  if (child.pid === undefined) throw new Error('e2e setup: could not start the server');
  fs.writeFileSync(PID_FILE, String(child.pid));
  child.unref();

  let exited = false;
  child.on('exit', () => (exited = true));
  const deadline = Date.now() + 60_000;
  while (!(await healthy())) {
    if (exited || Date.now() > deadline) {
      await stopServer();
      throw new Error(`e2e setup: the server did not become healthy (log: ${SERVER_LOG})`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  const mailer = startupMailer();
  if (mailer !== 'console') {
    await stopServer();
    throw new Error(`e2e setup: the server did not report the console mailer (got ${mailer}); stopped it.`);
  }

  return async () => {
    await stopServer();
  };
}
