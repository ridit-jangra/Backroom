-- Phase 6: operational signals (R11 email-failure banner). One row per kind; no foreign keys (R1).
CREATE TABLE ops_events (kind TEXT PRIMARY KEY, at INTEGER NOT NULL);
