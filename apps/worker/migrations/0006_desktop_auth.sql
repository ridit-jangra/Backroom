-- Phase 5: desktop login hand-off (PKCE). No foreign keys.
ALTER TABLE login_tokens ADD COLUMN desktop_challenge TEXT;
CREATE TABLE desktop_codes (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
