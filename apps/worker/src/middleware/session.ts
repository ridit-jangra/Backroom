import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { AppEnv } from '../app';
import { resolveSession, SESSION_COOKIE } from '../auth/sessions';
import { ApiError } from '../lib/errors';

const COOKIE_MAX_AGE_S = 30 * 86_400;

export function setSessionCookie(c: Context<AppEnv>, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: c.env.APP_ORIGIN.startsWith('https:'),
    sameSite: 'Lax',
    path: '/',
    maxAge: COOKIE_MAX_AGE_S,
  });
}

export function clearSessionCookie(c: Context<AppEnv>): void {
  setCookie(c, SESSION_COOKIE, '', {
    httpOnly: true,
    secure: c.env.APP_ORIGIN.startsWith('https:'),
    sameSite: 'Lax',
    path: '/',
    maxAge: 0,
  });
}

export const loadSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const cookieToken = getCookie(c, SESSION_COOKIE);
  const bearer = c.req.header('Authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];
  const now = c.var.deps.now();
  // Cookie first; a missing, empty or unresolvable cookie falls back to the Bearer token.
  if (cookieToken) {
    const result = await resolveSession(c.env.DB, cookieToken, now);
    if (result) {
      c.set('session', { userId: result.userId, token: cookieToken, via: 'cookie' });
      if (result.renewed) setSessionCookie(c, cookieToken);
    }
  }
  if (!c.var.session && bearer) {
    const result = await resolveSession(c.env.DB, bearer, now);
    if (result) c.set('session', { userId: result.userId, token: bearer, via: 'bearer' });
  }
  await next();
};

export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.var.session) throw new ApiError(401, 'unauthenticated', 'Sign in required.');
  await next();
};
