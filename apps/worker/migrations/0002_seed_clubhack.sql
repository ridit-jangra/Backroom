INSERT INTO workspaces (id, slug, name, settings_json, created_at)
VALUES ('01JCLUBHACK0000000000000WS', 'clubhack', 'clubhack', '{"customEmojiPolicy":"admins"}', 0);

INSERT INTO channels (id, workspace_id, name, kind, created_by, created_at) VALUES
  ('01JCLUBHACK0000000000000GN', '01JCLUBHACK0000000000000WS', 'general', 'public', NULL, 0),
  ('01JCLUBHACK0000000000000RD', '01JCLUBHACK0000000000000WS', 'random', 'public', NULL, 0);
