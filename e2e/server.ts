import fs from 'node:fs';
import { PID_FILE } from './paths';

function alive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Stops the server process group started by global setup, and nothing else (SIGTERM, then SIGKILL). */
export async function stopServer(): Promise<void> {
  let pgid: number;
  try {
    pgid = Number(fs.readFileSync(PID_FILE, 'utf8'));
  } catch {
    return;
  }
  fs.rmSync(PID_FILE, { force: true });
  if (!Number.isInteger(pgid) || pgid <= 1 || !alive(pgid)) return;
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
