-- Phase 6 Task 7 fix round 1: the workspace quota bounds every blob in KV (originals, thumbnails, custom emoji),
-- so thumbnail and emoji sizes are recorded. Existing rows count as 0 bytes. No foreign keys (R1).
ALTER TABLE files ADD COLUMN thumb_size INTEGER NOT NULL DEFAULT 0;
ALTER TABLE custom_emoji ADD COLUMN size INTEGER NOT NULL DEFAULT 0;
