import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../app';
import { ApiError } from '../lib/errors';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export const requireSameOrigin = createMiddleware<AppEnv>(async (c, next) => {
  if (!SAFE.has(c.req.method) && c.req.header('Origin') !== c.env.APP_ORIGIN) {
    throw new ApiError(403, 'bad_origin', 'Origin not allowed');
  }
  await next();
});
