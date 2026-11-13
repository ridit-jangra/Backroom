import type { ClientFrame } from '@backroom/protocol';

/** Phase 6 per-socket frame budget (token bucket): refill rate in frames per second. */
export const FRAME_BUDGET_PER_SEC = 10;
/** Bucket size: a fresh socket may send this many frames at once. */
export const FRAME_BUDGET_BURST = 20;
/** `typing` is cheap: five typing frames cost one frame. */
export const TYPING_FRAME_COST = 0.2;

/** Serialized on the socket attachment (hibernation-safe). Absent means a full bucket. */
export type FrameBudget = { tokens: number; at: number };

/** Float slack so 5 × 0.2 counts as exactly 1 token. */
const EPSILON = 1e-9;

/** What a frame costs, or null for frames the budget does not count (hello, mark_read, activity, ping…). */
export function frameCost(f: ClientFrame): number | null {
  switch (f.t) {
    case 'send':
    case 'edit':
    case 'delete':
    case 'react':
      return 1;
    case 'typing':
      return TYPING_FRAME_COST;
    default:
      return null;
  }
}

/** Refills by elapsed time (never backwards), caps at the burst, then takes `cost` if it is there. */
export function takeFrameBudget(
  budget: FrameBudget | undefined,
  cost: number,
  now: number,
): { ok: boolean; budget: FrameBudget } {
  const prev = budget ?? { tokens: FRAME_BUDGET_BURST, at: now };
  const elapsed = Math.max(0, now - prev.at);
  const tokens = Math.min(FRAME_BUDGET_BURST, prev.tokens + (elapsed * FRAME_BUDGET_PER_SEC) / 1000);
  // A clock that went backwards keeps the later stamp, so it cannot be replayed into a refill.
  const at = Math.max(now, prev.at);
  if (tokens + EPSILON >= cost) return { ok: true, budget: { tokens: Math.max(0, tokens - cost), at } };
  return { ok: false, budget: { tokens, at } };
}
