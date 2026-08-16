import { useEffect, useState } from 'react'
import type { LatLng, PlanMeta } from '@rv/shared'
import {
  RESCAN_RADIUS_KM,
  rescanCorridorArea,
  visibleRadiusKm,
} from '../lib/rescanCorridorAction'
import {
  describeExploreHighlightsError,
  GENERIC_STOPS_ERROR,
} from '../lib/exploreCandidateActions'
import { reverseGeocodeName } from '../lib/reverseGeocode'

interface RescanCorridorButtonProps {
  tripId: string
  center: LatLng
  /**
   * The visible map rectangle. "This area" means what the traveler can see,
   * not a fixed circle around the centre — see visibleRadiusKm.
   */
  bounds?: { north: number; south: number; east: number; west: number }
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

/**
 * How long a running scan may go without a heartbeat before it counts as
 * over.
 *
 * The callable clears its own status on the way out, success or failure —
 * but a container killed by its own ceiling never reaches that code, and the
 * trip is left saying 'generating' forever. Reported at "Scanning… 10m 47s",
 * well past anything the server could still be doing.
 *
 * This used to be measured from the scan's start, which meant waiting out a
 * fixed six minutes before the button came back, because a start time cannot
 * tell a slow scan from a dead one. It is now measured against a real
 * heartbeat (see rescanCorridorCallable.ts's RESCAN_HEARTBEAT_MS, every 20s),
 * so a run that has genuinely stopped is recognised in under a minute while a
 * slow one is never cut off at all.
 */
const STALE_HEARTBEAT_MS = 75_000

function isStale(beatAt: string | undefined, now: number): boolean {
  // No heartbeat at all means a scan started by the previous deploy, before
  // the callable wrote one. Trusted rather than declared dead: the cost of
  // being wrong here is a button that comes back too early and invites a
  // second paid search.
  if (!beatAt) return false
  const beat = new Date(beatAt).getTime()
  return Number.isFinite(beat) && now - beat > STALE_HEARTBEAT_MS
}

/**
 * What to say when a search comes back.
 *
 * "Nothing new found nearby" was said even when the search had found real
 * places and discarded every one of them for sitting outside the area — a
 * sentence describing a completely different failure from the one that
 * happened, and the reason a narrow search read as a broken one. When
 * something was thrown away, say that instead, and name the fix.
 */
function describeResult(found: number, droppedTooFar: number): string {
  if (found > 0) {
    return `Found ${found} new stop${found === 1 ? '' : 's'} nearby.`
  }
  if (droppedTooFar > 0) {
    return `Found ${droppedTooFar} place${droppedTooFar === 1 ? '' : 's'}, but ${droppedTooFar === 1 ? 'it was' : 'they were'} outside the area searched — zoom out and scan again to include ${droppedTooFar === 1 ? 'it' : 'them'}.`
  }
  return 'Nothing new found nearby.'
}

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
  bounds,
  planMeta,
}: RescanCorridorButtonProps) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Set when this device lost the connection to a scan the server is still
  // running — see the catch below.
  const [disconnected, setDisconnected] = useState(false)
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
  // A scan the server has stopped reporting does not count as running,
  // however the trip still describes it — see STALE_HEARTBEAT_MS.
  const abandoned =
    planMeta.rescanStatus === 'generating' &&
    isStale(planMeta.rescanStatusUpdatedAt, now)
  const scanning =
    submitting || (planMeta.rescanStatus === 'generating' && !abandoned)

  // Only ticks while a scan is actually running, so an idle map isn't
  // re-rendering once a second for a counter nobody is looking at.
  useEffect(() => {
    // Keyed on the trip's own claim rather than on `scanning`: the clock has
    // to keep running right up to the point the claim goes stale, or nothing
    // would ever re-render to notice that it had.
    if (planMeta.rescanStatus !== 'generating') return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [planMeta.rescanStatus])

  /**
   * The confirmation, recovered from the trip rather than remembered here —
   * so it is waiting for the traveler when they come back to the tab,
   * whether or not the connection that started the scan survived.
   */
  // The server's own account of the last failure, which outlives the
  // connection that started it — see planMeta.rescanLastError. Shown only
  // when it is the most recent thing that happened, so a fixed problem
  // stops being reported the moment a scan succeeds.
  const lastFailedFirst =
    !!planMeta.rescanLastFailedAt &&
    (!planMeta.rescanLastRunAt ||
      planMeta.rescanLastFailedAt > planMeta.rescanLastRunAt)
  const serverError =
    planMeta.rescanStatus !== 'generating' && lastFailedFirst
      ? planMeta.rescanLastError
      : undefined

  // Ordered deliberately: a scan still running outranks the news that this
  // phone stopped watching it, because the first is what the traveler asked
  // about and the second is only an explanation for the wait.
  const status = scanning && disconnected
    ? 'Still scanning — this phone stopped following it, but the search is running on the server. Anything it finds appears on the map on its own; you can leave this screen.'
    : abandoned
    ? 'That scan stopped reporting back — it may have run out of time. Anything it did find is already on the map.'
    : planMeta.rescanStatus !== 'generating' && !lastFailedFirst && planMeta.rescanLastRunAt
      ? describeResult(
          planMeta.rescanLastFoundCount ?? 0,
          planMeta.rescanLastDroppedTooFar ?? 0,
        )
      : null

  // Falls back to the old fixed circle only until the map has reported a
  // camera change, which in practice is immediately.
  const area = bounds ? visibleRadiusKm(bounds) : { radiusKm: RESCAN_RADIUS_KM }

  async function rescan() {
    setSubmitting(true)
    setError(null)
    setDisconnected(false)
    try {
      const centerName = await reverseGeocodeName(center)
      // The result is deliberately ignored: the server writes it to the trip
      // and the status above reads it back from there, so the answer is the
      // same whether this promise resolved or the connection died with the
      // tab. Awaited only so a failure still surfaces to whoever is watching.
      await rescanCorridorArea(
        tripId,
        center,
        area.radiusKm,
        undefined,
        undefined,
        centerName,
      )
    } catch (err) {
      console.error('rescanCorridor failed', err)
      // A dead connection is not a failed search.
      //
      // Holding a callable open for minutes from a phone does not work:
      // iOS Safari, a cellular NAT timeout or the screen locking will drop
      // the request long before any deadline we set expires. The function
      // keeps running — the client hanging up does not cancel it — and its
      // finds still arrive over the corridorStops subscription. Reported as
      // a red "please try again" sitting beside a live "Scanning… 3m 16s",
      // which is two contradictory claims about the same scan, and the
      // wrong one is the banner.
      //
      // So the trip decides, not the socket: while it still says a scan is
      // running, the connection dropping is a fact about this phone and
      // nothing the traveler needs to act on. Only a server that actually
      // answered — describeExploreHighlightsError finds a real cause in it —
      // gets to put an error on screen.
      const described = describeExploreHighlightsError(err)
      const serverAnswered = described !== GENERIC_STOPS_ERROR
      if (serverAnswered) setError(described)
      else setDisconnected(true)
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
          ? elapsedLabel(
              // Counted from when the scan began, not from its last
              // heartbeat — the heartbeat moves every 20 seconds, which
              // would reset the counter to zero for as long as the scan ran.
              planMeta.rescanStartedAt ?? planMeta.rescanStatusUpdatedAt,
              now,
            )
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
      {/* The local rejection when there is one, the trip's own record of the
          failure otherwise — the latter is what survives a phone that stopped
          following the call, which is how these failures kept arriving with
          no cause attached. */}
      {(error ?? serverError) && (
        <p
          data-testid="rescan-corridor-error"
          className="rounded bg-white/95 px-2 py-1 text-xs text-red-600 shadow-md backdrop-blur-sm dark:bg-neutral-900/95 dark:text-red-400"
        >
          {error ?? `That scan failed: ${serverError}`}
        </p>
      )}
    </div>
  )
}
