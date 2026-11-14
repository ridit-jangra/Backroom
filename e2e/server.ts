import fs from 'node:fs';
import { PID_FILE, SERVER_BUNDLE } from './paths';

function alive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

/** True when `pid` is still our server (guards against a recycled pid after a crash or reboot). */
function isOurServer(pid: number): boolean {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(SERVER_BUNDLE);
  } catch {
    // No /proc (not Linux): trust the pid file.
    return !fs.existsSync('/proc');
  }
}

function readPid(): number | null {
  let pgid: number;
  try {
    pgid = Number(fs.readFileSync(PID_FILE, 'utf8'));
  } catch {
    return null;
  }
  return Number.isInteger(pgid) && pgid > 1 ? pgid : null;
}

/**
 * Synchronous last resort for a runner that exits without running global teardown: SIGKILL the server's process
 * group if the pid file still names it.
 */
export function killServerSync(): void {
  const pgid = readPid();
  if (pgid === null || !alive(pgid) || !isOurServer(pgid)) return;
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    /* already gone */
  }
  fs.rmSync(PID_FILE, { force: true });
}

/** Stops the server process group started by global setup, and nothing else (SIGTERM, then SIGKILL). */
export async function stopServer(): Promise<void> {
  const pgid = readPid();
  fs.rmSync(PID_FILE, { force: true });
  if (pgid === null || !alive(pgid) || !isOurServer(pgid)) return;
  try {
    process.kill(-pgid, 'SIGTERM');
  } catch {
    return;
  }
  // The server's graceful shutdown is capped at about 11 s (1 s WebSocket grace + 10 s drain).
  const deadline = Date.now() + 15_000;
  while (alive(pgid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  if (alive(pgid)) {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}
