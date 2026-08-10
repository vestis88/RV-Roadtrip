import { useCallback, useEffect, useState } from 'react'
import type { PlanStatus } from '@rv/shared'

/** The two statuses that mean the backend is actively rewriting the plan. */
export function isPlanBusy(status: PlanStatus): boolean {
  return status === 'pending' || status === 'generating'
}

/**
 * How long to keep believing our own submission before giving up on ever
 * seeing it reflected in planMeta.status.
 *
 * A planRequest is a Firestore write; generatePlan is a trigger on that
 * write. A cold start puts seconds between the two. Without the optimistic
 * window below, the UI is idle for exactly that gap — which is precisely
 * when a traveler who saw nothing happen taps the button again.
 *
 * The ceiling exists so a request that is never picked up at all (trigger
 * not deployed, quota exhausted) unwedges the controls instead of disabling
 * them forever.
 */
const OPTIMISTIC_BUSY_MS = 30_000

/**
 * Whether the plan is busy, counting a submission this client just made but
 * has not yet seen acknowledged.
 *
 * This exists because of a real incident: "Add a rest day here" and "Request
 * changes for this day" both wrote a planRequest and then showed nothing at
 * all — Day View never rendered planMeta.status, unlike Overview and
 * Settings. runInsertRestDay is mechanical and sub-second, so the trip was
 * back to 'ready' almost immediately and the button was live again. Tapping
 * it repeatedly, which is what anyone does when a button appears to do
 * nothing, inserted a rest day every time. A three-day trip became eleven
 * days.
 *
 * Note what did NOT fail: generatePlan's claim transaction rejects a request
 * only while another is genuinely in flight, so it never rejected any of
 * these. It is a concurrency guard, and this was not concurrency — it was
 * the same deliberate action, requested many times, by someone with no way
 * to know the first one had landed. The fix belongs here, in what the
 * traveler can see, not in the lock.
 */
export function usePlanBusy(status: PlanStatus): {
  busy: boolean
  /** Call immediately after a planRequest write succeeds. */
  markSubmitted: () => void
} {
  const [submittedAt, setSubmittedAt] = useState<number | null>(null)
  const backendBusy = isPlanBusy(status)

  // Once the backend confirms it is working, our own optimism is redundant —
  // drop it so the real status governs from then on, including the moment it
  // stops being busy.
  //
  // Adjusted during render (React's documented "adjusting state when a prop
  // changes" pattern, the same one DayViewScreen uses to reset its selected
  // place on a day change) rather than in an effect: an effect would let one
  // frame render with both the backend busy and our optimism still set, and
  // the whole point of this hook is that the busy state is never wrong.
  const [sawBackendBusy, setSawBackendBusy] = useState(backendBusy)
  if (sawBackendBusy !== backendBusy) {
    setSawBackendBusy(backendBusy)
    if (backendBusy) setSubmittedAt(null)
  }

  useEffect(() => {
    if (submittedAt === null) return
    const timer = setTimeout(() => setSubmittedAt(null), OPTIMISTIC_BUSY_MS)
    return () => clearTimeout(timer)
  }, [submittedAt])

  const markSubmitted = useCallback(() => setSubmittedAt(Date.now()), [])

  return { busy: backendBusy || submittedAt !== null, markSubmitted }
}
