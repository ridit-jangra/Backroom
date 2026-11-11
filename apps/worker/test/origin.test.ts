import { env } from 'cloudflare:test';
import { it, expect } from 'vitest';
import { createApp } from '../src/app';
import { ApiError } from '../src/lib/errors';
import { testDeps } from './helpers';

function build() {
  const app = createApp(testDeps());
  app.post('/w/x/probe', (c) => c.json({ ok: true }));
  app.get('/w/x/fail', () => { throw new ApiError(404, 'not_found', 'nope'); });
  return app;
}

it('rejects a POST without Origin', async () => {
  const res = await build().request('/w/x/probe', { method: 'POST' }, env);
  expect(res.status).toBe(403);
  const body = (await res.json()) as { error: { code: string } };
  expect(body.error.code).toBe('bad_origin');
});
it('rejects a POST with a foreign Origin', async () => {
  const res = await build().request('/w/x/probe', { method: 'POST', headers: { Origin: 'https://evil.test' } }, env);
  expect(res.status).toBe(403);
});
it('allows a POST with the app Origin', async () => {
  const res = await build().request('/w/x/probe', { method: 'POST', headers: { Origin: 'https://app.test' } }, env);
  expect(res.status).toBe(200);
});
it('renders ApiError as a JSON error body', async () => {
  const res = await build().request('/w/x/fail', {}, env);
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'nope' } });
});
