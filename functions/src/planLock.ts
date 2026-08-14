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

/**
 * Merge into the trip update that runs once a plan operation has finished —
 * successfully or not — so the next request can tell whether it was written
 * before or after that run. See wasSubmittedBeforeRunEnded.
 */
export function planRunEndedFields(): { 'planMeta.lastRunEndedAt': string } {
  return { 'planMeta.lastRunEndedAt': new Date().toISOString() }
}

/**
 * The duplicate-submission guard, and the half of the cost guard that the
 * `planMeta.status` check alone cannot cover.
 *
 * The status check answers "is a run in flight *at the moment this trigger
 * happens to fire*". That is a different question from the one that matters,
 * and the difference is a window wide enough to destroy a trip: a planRequest
 * is a Firestore write and generatePlan is a trigger on it, so between the
 * write landing and the trigger claiming the trip, `planMeta.status` is still
 * 'ready'. A second request written inside that window sees a trip that looks
 * idle. Whether it is then refused depends entirely on when Eventarc gets
 * around to delivering its event — during the first run it is refused, after
 * the first run it is waved through and a second (Claude-costed, day-
 * rewriting) operation runs against a plan the traveler already changed once.
 * Reported twice now: 2026-08-11 via "Add a rest day here" (a three-day trip
 * became eleven), and 2026-08-13 via the overnight-stop picker.
 *
 * This closes the window instead of narrowing it, because it stops asking a
 * question about *now*. Both inputs are server timestamps that are already
 * fixed by the time any trigger runs: when the request was committed, and
 * when the previous run finished. A request committed before a run that has
 * since ended was, by definition, submitted against a plan that no longer
 * exists — it is a duplicate, whether it was written a millisecond before the
 * claim or an hour before. Delaying, reordering or redelivering either
 * trigger cannot change the answer, which is exactly what "closed" means
 * here: there is no interleaving left that admits two runs from one burst of
 * taps.
 *
 * Only requests genuinely submitted after the last run ended get through — a
 * traveler asking for another change once they can see the previous one, the
 * case the whole feature exists for.
 */
export function wasSubmittedBeforeRunEnded(
  submittedAtMs: number,
  lastRunEndedAt: string | undefined,
): boolean {
  if (!lastRunEndedAt) return false
  const endedAtMs = new Date(lastRunEndedAt).getTime()
  if (Number.isNaN(endedAtMs)) return false
  return submittedAtMs <= endedAtMs
}
