import { useEffect, useState } from 'react'
import type { LatLng, PlanMeta } from '@rv/shared'
import { RESCAN_RADIUS_KM, rescanCorridorArea } from '../lib/rescanCorridorAction'
import { describeExploreHighlightsError } from '../lib/exploreCandidateActions'
import { reverseGeocodeName } from '../lib/reverseGeocode'

interface RescanCorridorButtonProps {
  tripId: string
  center: LatLng
  /** Live from the trip doc — see the note on durable status below. */
  planMeta: PlanMeta
}

/**
 * How long a scan has to have been running before the elapsed time is worth
 * showing. A search that answers quickly should just answer; a counter
 * appearing on every one would read as a warning rather than reassurance.
 * Past this, silence is the thing that needs explaining — reported as "it
 * spent two minutes without a result", which is a long time to look at a
 * spinner with no evidence anything is happening.
 */
const SHOW_ELAPSED_AFTER_MS = 20_000

function elapsedLabel(startedAt: string | undefined, now: number): string {
  if (!startedAt) return 'Scanning…'
  const ms = now - new Date(startedAt).getTime()
  if (!Number.isFinite(ms) || ms < SHOW_ELAPSED_AFTER_MS) return 'Scanning…'
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.floor((ms % 60_000) / 1000)
  return minutes > 0 ? `Scanning… ${minutes}m ${seconds}s` : `Scanning… ${seconds}s`
}

/**
 * "Rescan this area" (phase 3): searches near the map's current center and
 * writes any finds as new `proposed` corridorStops, which then render on the
 * map for the traveler to lock in or remove (see CorridorStopCard). No
 * result list here — the map itself is the result view, same philosophy as
 * everywhere else this corridor is edited directly on the map rather than in
 * a separate screen.
 */
export function RescanCorridorButton({
  tripId,
  center,
  planMeta,
}: RescanCorridorButtonProps) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  /**
   * Whether a scan is running is a fact about the TRIP, not about this
   * component. The component unmounts whenever the traveler switches tabs,
   * and it used to take the whole answer with it: the search kept running
   * server-side and its finds still arrived (corridorStops is a live
   * subscription), but the button came back idle with no confirmation, which
   * looks exactly like a search that died — and invites pressing it again
   * for a second paid Claude call.
   *
   * `submitting` covers only the gap between the tap and the server writing
   * its status, so the button doesn't flash idle in between.
   */
  const scanning = submitting || planMeta.rescanStatus === 'generating'

  // Only ticks while a scan is actually running, so an idle map isn't
  // re-rendering once a second for a counter nobody is looking at.
  useEffect(() => {
    if (!scanning) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [scanning])

  /**
   * The confirmation, recovered from the trip rather than remembered here —
   * so it is waiting for the traveler when they come back to the tab,
   * whether or not the connection that started the scan survived.
   */
  const status =
    planMeta.rescanStatus !== 'generating' && planMeta.rescanLastRunAt
      ? planMeta.rescanLastFoundCount
        ? `Found ${planMeta.rescanLastFoundCount} new stop${planMeta.rescanLastFoundCount === 1 ? '' : 's'} nearby.`
        : 'Nothing new found nearby.'
      : null

  async function rescan() {
    setSubmitting(true)
    setError(null)
    try {
      const centerName = await reverseGeocodeName(center)
      // The result is deliberately ignored: the server writes it to the trip
      // and the status above reads it back from there, so the answer is the
      // same whether this promise resolved or the connection died with the
      // tab. Awaited only so a failure still surfaces to whoever is watching.
      await rescanCorridorArea(
        tripId,
        center,
        RESCAN_RADIUS_KM,
        undefined,
        undefined,
        centerName,
      )
    } catch (err) {
      console.error('rescanCorridor failed', err)
      // The server's own account where it has one — a search that ran out
      // of time can say so and name what would make it finish, which
      // "please try again" actively contradicts.
      setError(describeExploreHighlightsError(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        data-testid="rescan-corridor-button"
        disabled={scanning}
        onClick={rescan}
        className="btn btn-sm border border-dashed border-neutral-300 bg-white/95 text-neutral-600 shadow-md backdrop-blur-sm hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900/95 dark:text-neutral-300 dark:hover:bg-neutral-800"
      >
        {scanning
          ? elapsedLabel(planMeta.rescanStatusUpdatedAt, now)
          : 'Rescan this area'}
      </button>
      {status && (
        <p
          data-testid="rescan-corridor-status"
          className="rounded bg-white/95 px-2 py-1 text-xs text-neutral-600 shadow-md backdrop-blur-sm dark:bg-neutral-900/95 dark:text-neutral-300"
        >
          {status}
        </p>
      )}
      {error && (
        <p
          data-testid="rescan-corridor-error"
          className="rounded bg-white/95 px-2 py-1 text-xs text-red-600 shadow-md backdrop-blur-sm dark:bg-neutral-900/95 dark:text-red-400"
        >
          {error}
        </p>
      )}
    </div>
  )
}
