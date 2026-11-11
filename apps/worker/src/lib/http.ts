import type { Context } from 'hono';
import { ApiError } from './errors';

/** Parse the JSON request body, mapping parse failures to a 400. */
export async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ApiError(400, 'invalid_request', 'Invalid request body.');
  }
}
