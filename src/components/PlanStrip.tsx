import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Trip } from '@rv/shared'
import type { TripDayWithId } from '../hooks/useTripDays'
import type { CorridorStopWithId } from '../hooks/useCorridorStops'
import { submitPlanChangeRequest } from '../lib/submitChangeRequest'
import { usePlanBusy } from '../lib/planBusy'
import { ReorderCorridorPanel } from './ReorderCorridorPanel'

/**
 * Everything the day-by-day plan adds to the map, as a strip ON the board
 * rather than as a screen that replaces it.
 *
 * Reported 2026-08-23: "As soon as it goes to detailed plan, I feel like it's
 * too restricting and I actually lose the overview… I don't like that it goes
 * 'stale' and needs full generation. It should just grow organically."
 *
 * The overview was not lost to a design decision about layout. It was lost to
 * ONE branch — `if (planStatus === 'idle') return <ExploreMapScreen …>` — which
 * meant the board existed only while no plan did. The moment a plan appeared,
 * the screen was swapped for a different one and every curation action on it
 * went with the swap.
 *
 * So the board stays, at every plan status, and this is what the plan
 * contributes to it: what the trip currently costs, a way into each day, and
 * the two operations that change the route. A plan is now something the trip
 * HAS, not somewhere the traveler GOES.
 *
 * Its own component rather than more lines in ExploreMapScreen for a plain
 * reason: it owns three pieces of local state (the change-request form, the
 * reorder panel, the pacing dismissal) that nothing else on the board needs,
 * and folding them in would have made the board's own state harder to follow
 * than the feature is worth.
 */
export function PlanStrip({
  tripId,
  trip,
  days,
  corridorStops,
  reorderOpen,
  onReorderOpenChange,
}: {
  tripId: string
  trip: Trip
  days: TripDayWithId[]
  corridorStops: CorridorStopWithId[]
  /**
   * Held by the board rather than here, for one reason: a locked stop with
   * no day yet gets an "Add to route" button on its own card (2026-08-19,
   * "give a locked, unlinked stop a real way into the route"), and that
   * button opens this panel. The cards are the board's, the panel's stop
   * lists are this component's, so the flag has to sit above both.
   */
  reorderOpen: boolean
  onReorderOpenChange: (open: boolean) => void
}) {
  const navigate = useNavigate()
  const [changeRequestOpen, setChangeRequestOpen] = useState(false)
  const [changeText, setChangeText] = useState('')
  const [lockedDayIds, setLockedDayIds] = useState<Set<string>>(new Set())
  const [changeRequestError, setChangeRequestError] = useState<string | null>(
    null,
  )
  const [submittingChangeRequest, setSubmittingChangeRequest] = useState(false)

  const planStatus = trip.planMeta.status
  // Same guard Day View uses: a replan already in flight makes a second
  // request meaningless, and this button was tappable throughout one.
  const { busy: planBusy, markSubmitted: markPlanSubmitted } =
    usePlanBusy(planStatus)

  // Ordered by their days, since corridorStops carries no sequence field of
  // its own — linkedDayIds already ties each stop back to real, ordered days.
  // An empty `days` cannot produce an order at all (every stop ties on
  // Infinity), which was reported as an intermittent wrong first stop in the
  // reorder panel, so it yields nothing rather than a guess.
  const dayIndexById = new Map(days.map((day) => [day.id, day.index]))
  const committedCorridorStops = (days.length === 0 ? [] : corridorStops)
    .filter((stop) => stop.status === 'committed')
    .map((stop) => ({
      id: stop.id,
      name: stop.name,
      earliestIndex: stop.linkedDayIds.reduce(
        (min, dayId) => Math.min(min, dayIndexById.get(dayId) ?? Infinity),
        Infinity,
      ),
    }))
    .sort((a, b) => a.earliestIndex - b.earliestIndex)

  // Locked stops with no linked day yet — a traveler-placed pin or a locked
  // rescan find. These are what reconciliation can add into the route.
  const addableCorridorStops = corridorStops
    .filter((stop) => stop.status === 'locked' && stop.linkedDayIds.length === 0)
    .map((stop) => ({ id: stop.id, name: stop.name }))

  // Advice about a trip that has back-loaded its driving. Dismissal is keyed
  // on the warnings themselves rather than a boolean: the plan is perfectly
  // usable with them, so this must not nag forever — but a different set has
  // something new to say and gets to say it.
  //
  // Held in sessionStorage rather than component state, reported 2026-08-24:
  // "It's ok on app launch, but not every time." Component state dies with
  // the component, and this one unmounts on every hop to Diary, Countries or
  // a day and back — so "Got it" bought silence until the next tap, which is
  // not what dismissing something means. A session is the right unit: the
  // banner gets one say per app launch, and every navigation after that
  // respects the answer.
  const pacingWarnings = trip.planMeta.pacingWarnings ?? []
  const pacingWarningKey = pacingWarnings.join('\n')
  const [dismissedPacingKey, setDismissedPacingKey] = useState<string | null>(
    () => readDismissedPacing(tripId),
  )
  const showPacingWarnings =
    pacingWarnings.length > 0 && pacingWarningKey !== dismissedPacingKey

  function dismissPacingWarnings() {
    setDismissedPacingKey(pacingWarningKey)
    rememberDismissedPacing(tripId, pacingWarningKey)
  }

  function toggleLock(dayId: string) {
    setLockedDayIds((prev) => {
      const next = new Set(prev)
      if (next.has(dayId)) next.delete(dayId)
      else next.add(dayId)
      return next
    })
  }

  async function submitChangeRequest() {
    setChangeRequestError(null)
    // A blank request fires the expensive path with no instructions at all.
    if (!changeText.trim()) {
      setChangeRequestError('Describe what you would like changed first.')
      return
    }
    setSubmittingChangeRequest(true)
    try {
      await submitPlanChangeRequest(
        tripId,
        trip,
        changeText,
        Array.from(lockedDayIds),
      )
      markPlanSubmitted()
      setChangeRequestOpen(false)
    } catch (error) {
      console.error('Failed to submit change request', error)
      setChangeRequestError('Could not send that request — please try again.')
    } finally {
      setSubmittingChangeRequest(false)
    }
  }

  return (
    <>
      <div
        className="surface flex flex-wrap items-center justify-center gap-x-2 gap-y-1 border-b border-neutral-200 px-3 py-2 text-sm dark:border-neutral-800"
        data-testid="map-header"
      >
        <span
          data-testid="header-total-km"
          className="chip chip-neutral px-3 py-1"
        >
          {(trip.planMeta.totalKm ?? 0).toFixed(0)} km
        </span>
        <span
          data-testid="header-avg-drive-minutes"
          className="chip chip-neutral px-3 py-1"
        >
          {(trip.planMeta.avgDriveMinutesPerDay ?? 0).toFixed(0)} min/day avg
        </span>
        <span
          data-testid="header-day-count"
          className="chip chip-accent px-3 py-1"
        >
          {days.length} days
        </span>
        <button
          type="button"
          data-testid="request-changes-button"
          className="btn btn-ghost disabled:opacity-40"
          disabled={planBusy}
          onClick={() => setChangeRequestOpen(true)}
        >
          {planBusy ? 'Updating…' : 'Request changes'}
        </button>
        {(committedCorridorStops.length > 1 ||
          addableCorridorStops.length > 0) && (
          <button
            type="button"
            data-testid="reorder-stops-button"
            className="btn btn-ghost disabled:opacity-40"
            disabled={planBusy}
            onClick={() => onReorderOpenChange(true)}
          >
            {planBusy ? 'Updating the plan…' : 'Edit route'}
          </button>
        )}
      </div>

      {/* The way into a day, now that opening one no longer costs the map.
        * Horizontally scrollable rather than wrapped: a two-month trip is
        * sixty of these, and sixty wrapped chips would push the map off the
        * screen — the exact failure the list below was given a height cap
        * for on 2026-08-19. */}
      <div
        className="flex gap-1.5 overflow-x-auto border-b border-neutral-200 px-3 py-2 dark:border-neutral-800"
        data-testid="day-strip"
      >
        {days.map((day) => (
          <button
            key={day.id}
            type="button"
            data-testid={`day-strip-${day.id}`}
            onClick={() => navigate(`/map/day/${day.id}`)}
            className="chip chip-neutral shrink-0 px-3 py-1 text-xs whitespace-nowrap hover:bg-neutral-200 dark:hover:bg-neutral-700"
          >
            <span className="font-medium">Day {day.index + 1}</span>
            <span className="ml-1.5 text-neutral-500 dark:text-neutral-400">
              {day.overnight.name}
            </span>
          </button>
        ))}
      </div>

      {showPacingWarnings && (
        <div
          data-testid="pacing-warning-banner"
          className="border-b border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
        >
          {pacingWarnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
          <button
            type="button"
            data-testid="dismiss-pacing-warning"
            className="mt-1 underline"
            onClick={dismissPacingWarnings}
          >
            Got it
          </button>
        </div>
      )}

      {reorderOpen && (
        <ReorderCorridorPanel
          tripId={tripId}
          stops={committedCorridorStops}
          addableStops={addableCorridorStops}
          planBusy={planBusy}
          onSubmitted={markPlanSubmitted}
          onClose={() => onReorderOpenChange(false)}
        />
      )}

      {changeRequestOpen && (
        <div className="border-b border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <textarea
            data-testid="change-request-text"
            className="field"
            placeholder="e.g. more beaches, skip big cities"
            value={changeText}
            onChange={(event) => setChangeText(event.target.value)}
          />
          <div className="mt-3 flex flex-wrap gap-2">
            {days.map((day) => (
              <label
                key={day.id}
                className="flex cursor-pointer items-center gap-1.5 rounded-full border border-neutral-300 px-3 py-1.5 text-sm text-neutral-700 transition hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
                data-testid={`lock-toggle-${day.id}`}
              >
                <input
                  type="checkbox"
                  className="accent-orange-600"
                  checked={lockedDayIds.has(day.id)}
                  onChange={() => toggleLock(day.id)}
                />
                Lock day {day.index + 1}
              </label>
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              data-testid="submit-change-request"
              className="btn btn-primary disabled:opacity-40"
              disabled={submittingChangeRequest || planBusy}
              onClick={() => void submitChangeRequest()}
            >
              {submittingChangeRequest ? 'Sending…' : 'Send request'}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setChangeRequestOpen(false)}
            >
              Cancel
            </button>
          </div>
          {changeRequestError && (
            <p data-testid="change-request-error" className="mt-2 text-sm text-red-600 dark:text-red-400">
              {changeRequestError}
            </p>
          )}
        </div>
      )}
    </>
  )
}

/**
 * Which set of pacing warnings this session has already been told about.
 *
 * sessionStorage, not localStorage: a dismissal that outlived the app would
 * mean a traveler who once said "Got it" never hears about a genuinely
 * different pacing problem in a month's time. Per trip, since the warnings
 * are.
 *
 * Both wrapped, because storage access throws outright rather than returning
 * null in Safari's private mode — and a banner that cannot be dismissed is a
 * far smaller failure than a board that will not render.
 */
function readDismissedPacing(tripId: string): string | null {
  try {
    return sessionStorage.getItem(pacingDismissalKey(tripId))
  } catch {
    return null
  }
}

function rememberDismissedPacing(tripId: string, warningKey: string): void {
  try {
    sessionStorage.setItem(pacingDismissalKey(tripId), warningKey)
  } catch {
    // Dismissal lasts as long as this mount, which is what it did before.
  }
}

function pacingDismissalKey(tripId: string): string {
  return `pacing-dismissed:${tripId}`
}

export default PlanStrip
