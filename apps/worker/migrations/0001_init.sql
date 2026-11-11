-- Backroom schema (spec section 4). No FOREIGN KEY constraints by design:
-- integrity is enforced in application code plus CHECK/UNIQUE constraints.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  avatar_key TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  joined_at INTEGER NOT NULL,
  deactivated_at INTEGER,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT,
  expires_at INTEGER NOT NULL,
  max_uses INTEGER,
  uses INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE login_tokens (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  invite_id TEXT,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT
);

-- desktop hand-off; session is created on exchange
CREATE TABLE login_codes (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('public', 'private', 'dm')),
  topic TEXT,
  dm_key TEXT,
  last_seq INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  archived_at INTEGER,
  UNIQUE (workspace_id, name),
  UNIQUE (workspace_id, dm_key)
);

CREATE TABLE channel_members (
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  notify TEXT NOT NULL DEFAULT 'mentions' CHECK (notify IN ('all', 'mentions', 'none')),
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  parent_id TEXT,
  body TEXT NOT NULL,
  also_in_channel INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted_at INTEGER,
  reply_count INTEGER NOT NULL DEFAULT 0,
  last_reply_at INTEGER,
  UNIQUE (channel_id, seq)
);

CREATE TABLE thread_follows (
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  last_read_reply_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE mentions (
  message_id TEXT NOT NULL,
  user_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('user', 'channel', 'here'))
);

CREATE TABLE reactions (
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE TABLE custom_emoji (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  r2_key TEXT,
  alias_for TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (workspace_id, name)
);

CREATE TABLE files (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  uploader_id TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  thumb_key TEXT,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE message_files (
  message_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  PRIMARY KEY (message_id, file_id)
);

CREATE INDEX idx_messages_channel_seq ON messages(channel_id, seq);
CREATE INDEX idx_messages_parent ON messages(parent_id);
CREATE INDEX idx_mentions_user ON mentions(user_id);
CREATE INDEX idx_mentions_message ON mentions(message_id);
CREATE INDEX idx_channel_members_user ON channel_members(user_id);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- Full-text search (external-content, kept in sync by triggers)
CREATE VIRTUAL TABLE messages_fts USING fts5(body, content='messages', content_rowid='rowid');
CREATE VIRTUAL TABLE files_fts USING fts5(name, content='files', content_rowid='rowid');

CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, body) VALUES (new.rowid, new.body);
END;
CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
END;
CREATE TRIGGER messages_fts_au AFTER UPDATE OF body ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
  INSERT INTO messages_fts(rowid, body) VALUES (new.rowid, new.body);
END;

CREATE TRIGGER files_fts_ai AFTER INSERT ON files BEGIN
  INSERT INTO files_fts(rowid, name) VALUES (new.rowid, new.name);
END;
CREATE TRIGGER files_fts_ad AFTER DELETE ON files BEGIN
  INSERT INTO files_fts(files_fts, rowid, name) VALUES ('delete', old.rowid, old.name);
END;
CREATE TRIGGER files_fts_au AFTER UPDATE OF name ON files BEGIN
  INSERT INTO files_fts(files_fts, rowid, name) VALUES ('delete', old.rowid, old.name);
  INSERT INTO files_fts(rowid, name) VALUES (new.rowid, new.name);
END;
