/**
 * Session-savings tally — Sprint 48 mobile parity for the web's
 * CelebrationToast `_sessionSavingsCents` counter.
 *
 * What this is
 * ------------
 * A module-level running total of monthly-equivalent savings the user
 * has racked up in the current app session. Resets on app reload.
 *
 * Why a module-level singleton (not Context)
 * ------------------------------------------
 * The counter has to be writable from anywhere (Subscriptions screen
 * dismiss/cancel handlers) and readable from anywhere (Money on the
 * Table header chip). React Context would force every consumer to
 * wrap in a Provider; a tiny pub/sub module is friendlier and matches
 * the web shape line-for-line so behavior is easy to reason about.
 *
 * Semantics — what counts as a saving
 * -----------------------------------
 * Only events that represent a real recurring spend reduction tally
 * here: cancelling an active subscription, or resolving a duplicate.
 * Dismissals ("this isn't actually a subscription") do NOT tally —
 * dismissing a false positive doesn't save the user anything because
 * there was never a charge.
 *
 * This mirrors the web gate in CelebrationToast.tsx:
 *   kind === "cancel_sub" || kind === "duplicate_resolved".
 */

export type SessionSavingsListener = (totalCents: number) => void;

let _sessionSavingsCents = 0;
const _listeners = new Set<SessionSavingsListener>();

/** Read the current running total. Useful for chip initial-state. */
export function getSessionSavings(): number {
  return _sessionSavingsCents;
}

/** Subscribe to total changes. Returns an unsubscribe fn. */
export function subscribeSessionSavings(fn: SessionSavingsListener): () => void {
  _listeners.add(fn);
  return () => {
    _listeners.delete(fn);
  };
}

/** Record monthly-equivalent savings from a successful cancel/dedupe.
 *  No-op for non-positive amounts. */
export function emitSessionSavings(monthlyCents: number): void {
  if (!Number.isFinite(monthlyCents) || monthlyCents <= 0) return;
  _sessionSavingsCents += monthlyCents;
  for (const fn of _listeners) fn(_sessionSavingsCents);
}
