/**
 * The documented env files must load the same way in every place the docs use them: sourced by a POSIX shell
 * (`set -a; . file`), by `node --env-file`, and by systemd's EnvironmentFile (same quoting rules as node for these
 * lines). A bare `EMAIL_FROM=Backroom <x@y>` is a shell redirect, so it must be quoted.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tempDir } from './helpers';

const here = dirname(fileURLToPath(import.meta.url));
const ENV_EXAMPLE = join(here, '../.env.example');
const GUIDE = join(here, '../../../docs/SELF_HOSTING.md');
const PRINT = "process.stdout.write(JSON.stringify({ APP_ORIGIN: process.env.APP_ORIGIN, OWNER_EMAIL: process.env.OWNER_EMAIL, EMAIL_FROM: process.env.EMAIL_FROM, DATA_DIR: process.env.DATA_DIR }))";

function viaShell(file: string): Record<string, string> {
  const out = execFileSync('sh', ['-c', 'set -a && . "$1" && set +a && exec "$2" -e "$3"', 'sh', file, process.execPath, PRINT], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  });
  return JSON.parse(out);
}

function viaNode(file: string): Record<string, string> {
  return JSON.parse(execFileSync(process.execPath, [`--env-file=${file}`, '-e', PRINT], { encoding: 'utf8', env: { PATH: process.env.PATH } }));
}

/** The sample env file in the guide: the ```sh block that starts with `# /etc/backroom/backroom.env`. */
function guideSample(): string {
  const m = /```sh\n(# \/etc\/backroom\/backroom\.env[^\n]*\n[\s\S]*?)```/.exec(readFileSync(GUIDE, 'utf8'));
  if (!m) throw new Error('sample env block not found in docs/SELF_HOSTING.md');
  const file = join(tempDir('backroom-env-'), 'backroom.env');
  writeFileSync(file, m[1]!);
  return file;
}

describe('documented env files', () => {
  it('apps/server/.env.example loads identically in sh and node --env-file', () => {
    const sh = viaShell(ENV_EXAMPLE);
    expect(sh.EMAIL_FROM).toBe('Backroom <noreply@localhost>');
    expect(sh.APP_ORIGIN).toBe('https://chat.example.com');
    expect(viaNode(ENV_EXAMPLE)).toEqual(sh);
  });

  it('the sample env file in docs/SELF_HOSTING.md loads identically in sh and node --env-file', () => {
    const file = guideSample();
    const sh = viaShell(file);
    expect(sh.EMAIL_FROM).toBe('Backroom <backroom@example.com>');
    expect(sh.DATA_DIR).toBe('/var/lib/backroom');
    expect(viaNode(file)).toEqual(sh);
  });
});
