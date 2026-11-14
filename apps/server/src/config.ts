/**
 * Server configuration from the environment (and two command-line flags), validated up front with errors that say
 * what to fix. Secrets (RESEND_API_KEY) and personal data (OWNER_EMAIL) are never echoed in errors or warnings.
 */
import { resolve } from 'node:path';

export const DEFAULT_PORT = 8080;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_EMAIL_FROM = 'Backroom <noreply@localhost>';
export const DEFAULT_DATA_DIR = './data';
export const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 190_000;
export const DEFAULT_MAX_CONNECTIONS = 2048;
export const DEFAULT_BACKUP_KEEP = 7;

export interface ServerConfig {
  appOrigin: string;
  ownerEmail: string;
  /** The Resend key, or 'dev' for the console mailer (the worker's `pickMailer` reads exactly this). */
  resendApiKey: string;
  mailer: 'console' | 'resend';
  emailFrom: string;
  /** Absolute; holds backroom.sqlite and blobs/. */
  dataDir: string;
  port: number;
  host: string;
  /** Lower-case header name trusted for the client IP, or null for the socket address. */
  trustedProxyHeader: string | null;
  webDist: string;
  filesQuotaBytes: number | null;
  fileMaxBytes: number | null;
  /** With TRUSTED_PROXY_HEADER: believe it only on requests carrying X-Backroom-Origin-Secret with this value. */
  trustedProxySecret: string | null;
  /** Idle keep-alive timeout; above the reverse proxy's own (180 s on the production host). */
  keepAliveTimeoutMs: number;
  /** Open connections (WebSockets included) beyond which new ones are dropped. */
  maxConnections: number;
  /** `--maintenance`: run the daily maintenance once and exit. */
  maintenance: boolean;
  /** `--backup <dir>`: snapshot the database and mirror the blobs into this directory, then exit. */
  backupDir: string | null;
  /** `--keep <n>`: snapshots kept by `--backup` (default 7). */
  keep: number;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const HEADER_NAME_RE = /^[a-z0-9!#$%&'*+.^_`|~-]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

function originOf(value: string): string | null {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password || u.search || u.hash || value.includes('?') || value.includes('#')) return null;
  if (u.pathname !== '/') return null;
  return u.origin;
}

function boundedInt(value: string | undefined, fallback: number, max: number, problem: string, problems: string[]): number {
  if (value === undefined || value === '') return fallback;
  const n = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n < 1 || n > max) {
    problems.push(`${problem} (got "${value}")`);
    return fallback;
  }
  return n;
}

function positiveBytes(name: string, value: string | undefined, problems: string[]): number | null {
  if (value === undefined || value === '') return null;
  const n = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) {
    problems.push(`${name} must be a positive whole number of bytes (got "${value}")`);
    return null;
  }
  return n;
}

export function loadConfig(
  env: Record<string, string | undefined>,
  argv: string[],
  opts: { cwd: string; defaultWebDist: string },
): { config: ServerConfig; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];

  let maintenance = false;
  let webDistFlag: string | null = null;
  let backupFlag: string | null = null;
  let keepFlag: string | null = null;
  /** `--name value` or `--name=value`; returns the index of the last argument consumed, or -1 if `a` is not `name`. */
  const valueFlag = (i: number, name: string, what: string, set: (v: string) => void): number => {
    const a = argv[i]!;
    if (a === name) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) problems.push(`${name} needs ${what}`);
      else set(v);
      return i + 1;
    }
    if (a.startsWith(`${name}=`)) {
      const v = a.slice(name.length + 1);
      if (!v) problems.push(`${name} needs ${what}`);
      else set(v);
      return i;
    }
    return -1;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--maintenance') {
      maintenance = true;
      continue;
    }
    let j = valueFlag(i, '--web-dist', 'a path', (v) => (webDistFlag = v));
    if (j < 0) j = valueFlag(i, '--backup', 'a directory', (v) => (backupFlag = v));
    if (j < 0) j = valueFlag(i, '--keep', 'a number', (v) => (keepFlag = v));
    if (j < 0) problems.push(`unknown argument: ${a}`);
    else i = j;
  }
  const backup = backupFlag !== null || argv.some((a) => a === '--backup' || a.startsWith('--backup='));
  if (backup && maintenance) problems.push('--backup and --maintenance cannot be combined');
  if (keepFlag !== null && !backup) problems.push('--keep only applies to --backup');
  let keep = DEFAULT_BACKUP_KEEP;
  if (keepFlag !== null) {
    const n = /^\d+$/.test(keepFlag) ? Number(keepFlag) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 10_000) problems.push(`--keep must be a whole number from 1 to 10000 (got "${keepFlag}")`);
    else keep = n;
  }

  let appOrigin = '';
  const rawOrigin = env.APP_ORIGIN ?? '';
  // A backup only reads DATA_DIR: the public URL and the owner are not needed (but are still checked when given).
  if (!rawOrigin) {
    if (!backup) problems.push('APP_ORIGIN is required: the public URL people open, e.g. https://chat.example.com');
  } else {
    const o = originOf(rawOrigin);
    if (!o) problems.push(`APP_ORIGIN must be an http or https URL with no path, query or fragment, e.g. https://chat.example.com (got "${rawOrigin}")`);
    else appOrigin = o;
  }

  const ownerEmail = (env.OWNER_EMAIL ?? '').trim();
  if (!ownerEmail) {
    if (!backup) problems.push('OWNER_EMAIL is required: the email address of the workspace owner');
  }
  else if (!EMAIL_RE.test(ownerEmail)) problems.push('OWNER_EMAIL must be an email address');

  const key = env.RESEND_API_KEY ?? '';
  const mailer: ServerConfig['mailer'] = key === '' || key === 'dev' ? 'console' : 'resend';
  if (mailer === 'console' && appOrigin.startsWith('https:')) {
    warnings.push(
      'WARNING: RESEND_API_KEY is not set (or is "dev"), so the console mailer prints sign-in links to stdout instead of emailing them, but APP_ORIGIN is https (a public deployment?). Set RESEND_API_KEY to send real email.',
    );
  }

  let port = DEFAULT_PORT;
  if (env.PORT !== undefined && env.PORT !== '') {
    const n = /^\d+$/.test(env.PORT) ? Number(env.PORT) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 65535) problems.push(`PORT must be an integer from 1 to 65535 (got "${env.PORT}")`);
    else port = n;
  }

  let trustedProxyHeader: string | null = null;
  const rawHeader = (env.TRUSTED_PROXY_HEADER ?? '').trim().toLowerCase();
  if (rawHeader) {
    if (!HEADER_NAME_RE.test(rawHeader)) problems.push(`TRUSTED_PROXY_HEADER must be a header name such as cf-connecting-ip or x-forwarded-for (got "${env.TRUSTED_PROXY_HEADER}")`);
    else trustedProxyHeader = rawHeader;
  }

  let trustedProxySecret: string | null = null;
  const rawSecret = env.TRUSTED_PROXY_SECRET ?? '';
  if (rawSecret) {
    if (rawSecret.length < 24 || !/^[\x21-\x7e]+$/.test(rawSecret)) {
      problems.push('TRUSTED_PROXY_SECRET must be at least 24 characters of visible ASCII (no spaces); generate one with: openssl rand -hex 32');
    } else if (!trustedProxyHeader && !rawHeader) {
      problems.push('TRUSTED_PROXY_SECRET needs TRUSTED_PROXY_HEADER (the secret only decides when that header is believed)');
    } else trustedProxySecret = rawSecret;
  }

  const filesQuotaBytes = positiveBytes('FILES_QUOTA_BYTES', env.FILES_QUOTA_BYTES, problems);
  const fileMaxBytes = positiveBytes('FILE_MAX_BYTES', env.FILE_MAX_BYTES, problems);

  const keepAliveTimeoutMs = boundedInt(
    env.KEEP_ALIVE_TIMEOUT_MS,
    DEFAULT_KEEP_ALIVE_TIMEOUT_MS,
    3_600_000,
    'KEEP_ALIVE_TIMEOUT_MS must be a whole number of milliseconds from 1 to 3600000',
    problems,
  );
  const maxConnections = boundedInt(env.MAX_CONNECTIONS, DEFAULT_MAX_CONNECTIONS, 1_000_000, 'MAX_CONNECTIONS must be a whole number from 1 to 1000000', problems);

  if (problems.length > 0) throw new ConfigError(problems.join('\n'));

  return {
    config: {
      appOrigin,
      ownerEmail,
      resendApiKey: mailer === 'console' ? 'dev' : key,
      mailer,
      emailFrom: env.EMAIL_FROM || DEFAULT_EMAIL_FROM,
      dataDir: resolve(opts.cwd, env.DATA_DIR || DEFAULT_DATA_DIR),
      port,
      host: env.HOST || DEFAULT_HOST,
      trustedProxyHeader,
      webDist: webDistFlag !== null ? resolve(opts.cwd, webDistFlag) : env.WEB_DIST ? resolve(opts.cwd, env.WEB_DIST) : opts.defaultWebDist,
      filesQuotaBytes,
      fileMaxBytes,
      trustedProxySecret,
      keepAliveTimeoutMs,
      maxConnections,
      maintenance,
      backupDir: backupFlag !== null ? resolve(opts.cwd, backupFlag) : null,
      keep,
    },
    warnings,
  };
}
