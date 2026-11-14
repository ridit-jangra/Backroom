/**
 * Server configuration from the environment (and two command-line flags), validated up front with errors that say
 * what to fix. Secrets (RESEND_API_KEY) and personal data (OWNER_EMAIL) are never echoed in errors or warnings.
 */
import { resolve } from 'node:path';

export const DEFAULT_PORT = 8080;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_EMAIL_FROM = 'Backroom <noreply@localhost>';
export const DEFAULT_DATA_DIR = './data';

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
  /** `--maintenance`: run the daily maintenance once and exit. */
  maintenance: boolean;
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
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--maintenance') maintenance = true;
    else if (a === '--web-dist') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) problems.push('--web-dist needs a path');
      else webDistFlag = v;
      i++;
    } else if (a.startsWith('--web-dist=')) {
      const v = a.slice('--web-dist='.length);
      if (!v) problems.push('--web-dist needs a path');
      else webDistFlag = v;
    } else problems.push(`unknown argument: ${a}`);
  }

  let appOrigin = '';
  const rawOrigin = env.APP_ORIGIN ?? '';
  if (!rawOrigin) problems.push('APP_ORIGIN is required: the public URL people open, e.g. https://chat.example.com');
  else {
    const o = originOf(rawOrigin);
    if (!o) problems.push(`APP_ORIGIN must be an http or https URL with no path, query or fragment, e.g. https://chat.example.com (got "${rawOrigin}")`);
    else appOrigin = o;
  }

  const ownerEmail = (env.OWNER_EMAIL ?? '').trim();
  if (!ownerEmail) problems.push('OWNER_EMAIL is required: the email address of the workspace owner');
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

  const filesQuotaBytes = positiveBytes('FILES_QUOTA_BYTES', env.FILES_QUOTA_BYTES, problems);
  const fileMaxBytes = positiveBytes('FILE_MAX_BYTES', env.FILE_MAX_BYTES, problems);

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
      maintenance,
    },
    warnings,
  };
}
