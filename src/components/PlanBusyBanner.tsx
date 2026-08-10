import type { PlanMeta } from '@rv/shared'

/**
 * "The plan is being rewritten right now" — the acknowledgement Day View
 * never had.
 *
 * Overview and Settings both render their own version of this; Day View,
 * which is where the two structural actions actually live ("Add a rest day
 * here", "Request changes for this day"), rendered nothing. A submission
 * there was indistinguishable from a dead button, and the trip paid for it.
 *
 * Deliberately shows the backend's own progressLabel when there is one
 * rather than a generic spinner: a traveler who can see "Planning day 4 of
 * 11" knows the tap landed, which is the entire point.
 */
export function PlanBusyBanner({
  planMeta,
  busy,
}: {
  planMeta: PlanMeta
  /**
   * Passed in rather than derived from planMeta alone so it can include a
   * submission this client has made but the backend has not yet picked up —
   * see usePlanBusy. That gap is where the repeated taps went.
   */
  busy: boolean
}) {
  if (busy) {
    return (
      <p
        data-testid="plan-busy-banner"
        className="mx-4 mt-2 rounded-lg border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-900 dark:border-sky-700 dark:bg-sky-950 dark:text-sky-100"
      >
        {planMeta.progressLabel ?? 'Updating your plan…'} You can keep looking
        around — this page updates when it finishes.
      </p>
    )
  }

  if (planMeta.status === 'error') {
    return (
      <p
        data-testid="plan-error-banner"
        className="mx-4 mt-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-100"
      >
        The last change to this plan failed
        {planMeta.error ? `: ${planMeta.error}` : '.'}
      </p>
    )
  }

  return null
}
