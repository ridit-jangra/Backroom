import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';
import type { ApiErrorBody } from '@backroom/protocol';

export class ApiError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function body(code: string, message: string): ApiErrorBody {
  return { error: { code, message } };
}

export function errorHandler(err: Error, c: Context): Response {
  if (err instanceof ApiError) return c.json(body(err.code, err.message), err.status);
  if (err instanceof ZodError) return c.json(body('invalid_request', 'Invalid request'), 400);
  // c.req.json() on a malformed body throws a bare SyntaxError.
  if (err instanceof SyntaxError) return c.json(body('invalid_request', 'Invalid request'), 400);
  if (err instanceof HTTPException) {
    const code = err.status === 400 ? 'invalid_request' : `http_${err.status}`;
    const message = err.status === 400 ? 'Invalid request' : err.message || 'Request failed';
    return c.json(body(code, message), err.status);
  }
  // Log only the error name and route, never messages (may contain emails/tokens).
  console.error(JSON.stringify({ level: 'error', name: err.name, path: c.req.routePath || new URL(c.req.url).pathname }));
  return c.json(body('internal', 'Internal server error'), 500);
}
