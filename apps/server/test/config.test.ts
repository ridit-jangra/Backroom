import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_EMAIL_FROM, loadConfig } from '../src/config';

const base = { APP_ORIGIN: 'https://chat.example.com', OWNER_EMAIL: 'owner@example.com', RESEND_API_KEY: 're_live_key' };
const opts = { cwd: '/srv/backroom', defaultWebDist: '/opt/backroom/web' };
const load = (env: Record<string, string | undefined>, argv: string[] = []) => loadConfig(env, argv, opts);

function errorOf(env: Record<string, string | undefined>, argv: string[] = []): string {
  try {
    load(env, argv);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as Error).message;
  }
  throw new Error('expected a ConfigError');
}

describe('loadConfig', () => {
  it('applies the defaults', () => {
    const { config, warnings } = load(base);
    expect(config).toEqual({
      appOrigin: 'https://chat.example.com',
      ownerEmail: 'owner@example.com',
      resendApiKey: 're_live_key',
      mailer: 'resend',
      emailFrom: DEFAULT_EMAIL_FROM,
      dataDir: '/srv/backroom/data',
      port: 8080,
      host: '127.0.0.1',
      trustedProxyHeader: null,
      webDist: '/opt/backroom/web',
      filesQuotaBytes: null,
      fileMaxBytes: null,
      maintenance: false,
    });
    expect(DEFAULT_EMAIL_FROM).toBe('Backroom <noreply@localhost>');
    expect(warnings).toEqual([]);
  });

  it('reads every setting', () => {
    const { config } = load({
      ...base,
      EMAIL_FROM: 'Chat <chat@example.com>',
      DATA_DIR: 'state',
      PORT: '9000',
      HOST: '0.0.0.0',
      TRUSTED_PROXY_HEADER: 'CF-Connecting-IP',
      WEB_DIST: '/srv/web',
      FILES_QUOTA_BYTES: '2000000000',
      FILE_MAX_BYTES: '1048576',
    });
    expect(config).toMatchObject({
      emailFrom: 'Chat <chat@example.com>',
      dataDir: '/srv/backroom/state',
      port: 9000,
      host: '0.0.0.0',
      trustedProxyHeader: 'cf-connecting-ip',
      webDist: '/srv/web',
      filesQuotaBytes: 2_000_000_000,
      fileMaxBytes: 1_048_576,
    });
  });

  it('APP_ORIGIN: required', () => {
    expect(errorOf({ ...base, APP_ORIGIN: undefined })).toMatch(/APP_ORIGIN is required/);
    expect(errorOf({ ...base, APP_ORIGIN: '' })).toMatch(/APP_ORIGIN is required/);
  });

  it.each(['chat.example.com', 'ftp://chat.example.com', 'https://chat.example.com/app', 'https://chat.example.com?x=1', 'https://chat.example.com/#a', 'https://user:pw@chat.example.com', 'not a url'])(
    'APP_ORIGIN: %s is refused',
    (v) => {
      expect(errorOf({ ...base, APP_ORIGIN: v })).toMatch(/APP_ORIGIN must be an http or https URL with no path, query or fragment/);
    },
  );

  it('APP_ORIGIN: a trailing slash is dropped, http and ports are fine', () => {
    expect(load({ ...base, APP_ORIGIN: 'https://chat.example.com/' }).config.appOrigin).toBe('https://chat.example.com');
    expect(load({ ...base, APP_ORIGIN: 'http://localhost:8790' }).config.appOrigin).toBe('http://localhost:8790');
  });

  it('OWNER_EMAIL: required and must look like an email (the value is never echoed)', () => {
    expect(errorOf({ ...base, OWNER_EMAIL: undefined })).toMatch(/OWNER_EMAIL is required/);
    const msg = errorOf({ ...base, OWNER_EMAIL: 'secret-not-an-email' });
    expect(msg).toMatch(/OWNER_EMAIL must be an email address/);
    expect(msg).not.toContain('secret-not-an-email');
  });

  it('RESEND_API_KEY: unset or "dev" selects the console mailer; https then warns loudly', () => {
    for (const key of [undefined, '', 'dev']) {
      const { config, warnings } = load({ ...base, RESEND_API_KEY: key });
      expect(config.mailer).toBe('console');
      expect(config.resendApiKey).toBe('dev');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/WARNING.*console mailer.*https/i);
    }
    const local = load({ ...base, APP_ORIGIN: 'http://localhost:8790', RESEND_API_KEY: 'dev' });
    expect(local.config.mailer).toBe('console');
    expect(local.warnings).toEqual([]);
  });

  it('the key never appears in errors or warnings', () => {
    const msg = errorOf({ ...base, PORT: 'x', RESEND_API_KEY: 're_SECRET' });
    expect(msg).not.toContain('re_SECRET');
  });

  it.each(['0', '65536', '80.5', 'abc', '-1'])('PORT: %s is refused', (v) => {
    expect(errorOf({ ...base, PORT: v })).toMatch(/PORT must be an integer from 1 to 65535/);
  });

  it.each(['x forwarded', 'a:b', 'é'])('TRUSTED_PROXY_HEADER: %s is refused', (v) => {
    expect(errorOf({ ...base, TRUSTED_PROXY_HEADER: v })).toMatch(/TRUSTED_PROXY_HEADER must be a header name/);
  });

  it('TRUSTED_PROXY_HEADER: empty means none', () => {
    expect(load({ ...base, TRUSTED_PROXY_HEADER: '' }).config.trustedProxyHeader).toBeNull();
  });

  it.each(['0', '-5', '1.5', '1e9', 'lots', '9007199254740993'])('FILES_QUOTA_BYTES / FILE_MAX_BYTES: %s is refused', (v) => {
    expect(errorOf({ ...base, FILES_QUOTA_BYTES: v })).toMatch(/FILES_QUOTA_BYTES must be a positive whole number of bytes/);
    expect(errorOf({ ...base, FILE_MAX_BYTES: v })).toMatch(/FILE_MAX_BYTES must be a positive whole number of bytes/);
  });

  it('EMAIL_FROM: an empty value falls back to the default', () => {
    expect(load({ ...base, EMAIL_FROM: '' }).config.emailFrom).toBe(DEFAULT_EMAIL_FROM);
  });

  it('reports every problem at once', () => {
    const msg = errorOf({ PORT: 'x' });
    expect(msg).toMatch(/APP_ORIGIN is required/);
    expect(msg).toMatch(/OWNER_EMAIL is required/);
    expect(msg).toMatch(/PORT must be/);
  });

  it('flags: --maintenance, --web-dist (wins over WEB_DIST), unknown flags refused', () => {
    expect(load(base, ['--maintenance']).config.maintenance).toBe(true);
    expect(load({ ...base, WEB_DIST: '/a' }, ['--web-dist', 'web']).config.webDist).toBe('/srv/backroom/web');
    expect(load(base, ['--web-dist=/b']).config.webDist).toBe('/b');
    expect(errorOf(base, ['--web-dist'])).toMatch(/--web-dist needs a path/);
    expect(errorOf(base, ['--frobnicate'])).toMatch(/unknown argument: --frobnicate/);
  });
});
