import { env } from 'cloudflare:test';
import { it, expect } from 'vitest';

it('seeds clubhack with general and random', async () => {
  const ws = await env.DB.prepare("SELECT id FROM workspaces WHERE slug='clubhack'").first<{ id: string }>();
  expect(ws).not.toBeNull();
  const { results } = await env.DB.prepare(
    'SELECT name, kind FROM channels WHERE workspace_id=? ORDER BY name').bind(ws!.id).all();
  expect(results).toEqual([{ name: 'general', kind: 'public' }, { name: 'random', kind: 'public' }]);
});

it('keeps messages_fts in sync on insert and soft delete', async () => {
  const ch = await env.DB.prepare("SELECT id FROM channels WHERE name='general'").first<{ id: string }>();
  await env.DB.prepare("INSERT INTO messages(id,channel_id,seq,user_id,body,created_at) VALUES ('m1',?,1,'u1','hello banana',0)").bind(ch!.id).run();
  const hit = () => env.DB.prepare("SELECT count(*) n FROM messages_fts WHERE messages_fts MATCH 'banana'").first<{ n: number }>();
  expect((await hit())!.n).toBe(1);
  await env.DB.prepare("UPDATE messages SET body='', deleted_at=1 WHERE id='m1'").run();
  expect((await hit())!.n).toBe(0);
});

it('rejects an invalid role', async () => {
  await expect(env.DB.prepare(
    "INSERT INTO workspace_members(workspace_id,user_id,role,joined_at) VALUES ('w','u','god',0)").run()).rejects.toThrow();
});
