-- Phase 4: a file attaches to exactly one message; per-workspace listing/quota by time.
CREATE UNIQUE INDEX idx_message_files_file ON message_files(file_id);
CREATE INDEX idx_files_ws_created ON files(workspace_id, created_at);
