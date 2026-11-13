/** Operational signals (migration 0007): one row per kind, holding when it last happened. */
export type OpsEventKind = 'email_failed';

export async function recordOpsEvent(db: D1Database, kind: OpsEventKind, at: number): Promise<void> {
  await db
    .prepare('INSERT INTO ops_events (kind, at) VALUES (?1, ?2) ON CONFLICT(kind) DO UPDATE SET at = MAX(at, ?2)')
    .bind(kind, at)
    .run();
}
