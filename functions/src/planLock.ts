/**
 * Staleness recovery for the `planMeta.status` busy guard.
 *
 * `generatePlan`'s claim transaction refuses to start when the trip is
 * already 'pending' or 'generating' — the cost guard that stops a
 * double-click from paying for two generations. But nothing ever expired
 * that claim: if the function's container is killed (the hard 540s ceiling,
 * an OOM, a deploy mid-run) after claiming and before any `catch` can set
 * 'error', the trip stays 'generating' forever and EVERY later generate,
 * replan, insertRestDay and reconcile on it is rejected — unrecoverable
 * without a manual Firestore edit. Same failure mode already fixed for
 * explore mode's own lock (exploreHighlightsCallable.ts's
 * STALE_EXPLORE_LOCK_MS); this is the far more consequential one, since
 * `planMeta.status` gates every expensive write path in the app.
 *
 * Generous on purpose. A real generation writes `statusUpdatedAt` often —
 * on claim, at each phase, and per resolved day (see the call sites of
 * planAliveFields) — and a chained continuation re-stamps it as it picks
 * up, so even a multi-week trip spanning several invocations never goes
 * this long without a write. Anything quieter than this really is dead.
 */
export const STALE_PLAN_LOCK_MS = 15 * 60 * 1000

/**
 * Merge into any `planMeta` update that means "this generation is still
 * alive" — the heartbeat isPlanLockStale reads. Kept as a spread-in helper
 * rather than a separate write so a heartbeat can never cost an extra
 * round-trip, and can never be forgotten at a site that's already updating
 * planMeta anyway.
 */
export function planAliveFields(): { 'planMeta.statusUpdatedAt': string } {
  return { 'planMeta.statusUpdatedAt': new Date().toISOString() }
}

/**
 * True when a 'pending'/'generating' claim is old enough to be abandoned.
 * A claim with no timestamp at all predates this mechanism — treated as
 * stale so trips already wedged before it shipped can recover too, rather
 * than staying permanently stuck.
 */
export function isPlanLockStale(
  statusUpdatedAt: string | undefined,
  now: number = Date.now(),
): boolean {
  if (!statusUpdatedAt) return true
  const updatedAt = new Date(statusUpdatedAt).getTime()
  if (Number.isNaN(updatedAt)) return true
  return now - updatedAt > STALE_PLAN_LOCK_MS
}
