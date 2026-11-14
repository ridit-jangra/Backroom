/**
 * Structured logs: one JSON object per line on stdout. Callers pass a short code and plain fields only; never
 * message bodies, emails, tokens, codes, verifiers, blob keys or raw error messages (they can carry any of these).
 */
export type LogLevel = 'info' | 'warn' | 'error';
export type Log = (level: LogLevel, code: string, fields?: Record<string, unknown>) => void;

export const log: Log = (level, code, fields = {}) => {
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), level, code, ...fields })}\n`);
};

/** What may be logged about an error: its class name and a Node error code, never its message. */
export function errorFields(e: unknown): { error: string; errno?: string } {
  const name = e instanceof Error ? e.name : typeof e;
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? { error: name, errno: code } : { error: name };
}
