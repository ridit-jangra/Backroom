-- Phase 2: durable clientId dedupe backstop (survives hub eviction). No FOREIGN KEYs (R1).
ALTER TABLE messages ADD COLUMN client_id TEXT;
CREATE UNIQUE INDEX idx_messages_client ON messages(user_id, client_id) WHERE client_id IS NOT NULL;
