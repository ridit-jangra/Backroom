-- The seeded workspace was displayed as "clubhack". Show "Backroom" instead.
-- Only the display name changes; the slug stays `clubhack` so existing links, cookies and the desktop app keep working.
-- Guarded so a name an owner already chose is never overwritten. No foreign keys (R1).
UPDATE workspaces SET name = 'Backroom' WHERE slug = 'clubhack' AND name = 'clubhack';
