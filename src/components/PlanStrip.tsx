import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Trip } from '@rv/shared'
import type { TripDayWithId } from '../hooks/useTripDays'
import type { CorridorStopWithId } from '../hooks/useCorridorStops'
import { submitPlanChangeRequest } from '../lib/submitChangeRequest'
import { usePlanBusy } from '../lib/planBusy'
import { ReorderCorridorPanel } from './ReorderCorridorPanel'
import {
  committedStopsInRouteOrder,
  stopsAddableToRoute,
} from '../lib/routeEditing'
import { dayStrip, derivedDayStrip } from '../lib/dayStrip'
import { applyDayCleanup, planDayCleanup, staleDays } from '../lib/dayCleanup'
import {
  planSkeleton,
  writeSkeletonDays,
  type SkeletonDecision,
} from '../lib/skeletonDays'

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
  routeStops,
  arrivals,
  routeLegs,
  reorderOpen,
  onReorderOpenChange,
  changeRequestOpen,
  onChangeRequestOpenChange,
  rebuildOpen,
  onRebuildOpenChange,
}: {
  tripId: string
  trip: Trip
  days: TripDayWithId[]
  corridorStops: CorridorStopWithId[]
  /**
   * The kept stops in driving order, and the real Google legs between them —
   * exactly what the board already hands the automatic skeleton writer. Passed
   * down so "Rebuild day list" derives the same itinerary that writer would,
   * rather than a second, subtly different one.
   */
  routeStops: CorridorStopWithId[]
  /**
   * When each kept stop is reached — see arrivalEstimates. Used to date the
   * strip when the stored days no longer describe these stops.
   */
  arrivals: Map<string, { date: string; committed: boolean }>
  routeLegs: { durationMin: number; distanceKm: number }[]
  /**
   * Held by the board rather than here, for one reason: a locked stop with
   * no day yet gets an "Add to route" button on its own card (2026-08-19,
   * "give a locked, unlinked stop a real way into the route"), and that
   * button opens this panel. The cards are the board's, the panel's stop
   * lists are this component's, so the flag has to sit above both.
   */
  reorderOpen: boolean
  onReorderOpenChange: (open: boolean) => void
  /**
   * The other two panels, lifted for the same reason `reorderOpen` was and
   * then one more.
   *
   * Reported 2026-08-24 with an annotated screenshot — "put on same row",
   * "I need the top part of the page to be more compact". The five actions
   * were split across two components' own header rows, which is why they
   * could never share one. The board now renders a single actions row and
   * owns which panel is open; this component keeps the panels themselves,
   * since the work each one does is the plan's, not the board's.
   */
  changeRequestOpen: boolean
  onChangeRequestOpenChange: (open: boolean) => void
  rebuildOpen: boolean
  onRebuildOpenChange: (open: boolean) => void
}) {
  const navigate = useNavigate()
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

  /**
   * Days whose stop has already left the route.
   *
   * Removal cleans up after itself now (see removeStopFromRoute), so this
   * only ever has anything in it for a trip that was edited BEFORE that
   * landed — reported 2026-08-24: "I've removed stops previously locked in
   * … but the items are still in the day list."
   *
   * Offered as a button rather than done on sight. These are real day
   * documents that may carry researched activities and restaurants, and a
   * screen that silently deleted them on load would be indistinguishable
   * from a bug — which is exactly what this is here to repair.
   */
  const stale = staleDays(corridorStops, days)
  const [tidying, setTidying] = useState(false)
  const [tidyError, setTidyError] = useState<string | null>(null)

  async function tidyStaleDays() {
    setTidyError(null)
    setTidying(true)
    try {
      await applyDayCleanup(
        tripId,
        planDayCleanup({
          removeDayIds: stale.map((day) => day.id),
          days,
          stops: corridorStops,
          startDate: trip.settings.startDate,
        }),
        corridorStops,
      )
    } catch (error) {
      console.error('Tidying stale days failed', error)
      setTidyError('Could not tidy those days — please try again.')
    } finally {
      setTidying(false)
    }
  }

  /**
   * Rebuilding the day list from the board.
   *
   * Requested 2026-08-24: "My intention was to not have to interact in the
   * same way with the day view." Everything else on this strip edits the
   * days; this one throws them away and re-derives them from the stops,
   * which is the only honest answer when the two have diverged.
   *
   * Behind a confirm, because it discards researched activities and
   * restaurants. Those cost real calls, and the days come back as `pending`
   * — DayDetailGate refills a day when it is opened, so nothing is lost
   * permanently, but it is not free either.
   */
  const [rebuilding, setRebuilding] = useState(false)
  const [rebuildError, setRebuildError] = useState<string | null>(null)

  async function rebuildDays() {
    setRebuildError(null)
    setRebuilding(true)
    try {
      const decision = planSkeleton({
        stops: routeStops,
        legs: routeLegs,
        existingDays: days,
        settings: trip.settings,
        planMeta: trip.planMeta,
        rebuildOverDetail: true,
      })
      if (!decision.days) {
        setRebuildError(describeSkeletonSkip(decision.skipped))
        return
      }
      await writeSkeletonDays(tripId, decision.days)
      onRebuildOpenChange(false)
    } catch (error) {
      console.error('Rebuilding the day list failed', error)
      setRebuildError('Could not rebuild the days — please try again.')
    } finally {
      setRebuilding(false)
    }
  }

  const nextStop = routeStops[0]
  const today = new Date().toISOString().slice(0, 10)
  const strip = dayStrip(days, today)
  const [showPastDays, setShowPastDays] = useState(false)
  /**
   * Kept stops the day list knows nothing about — the "old irrelevant stuff"
   * case. Counted rather than merely detected so the banner can say how far
   * out of step the two are.
   */
  const daysMissingKeptStops =
    days.length === 0 ? 0 : stopsAddableToRoute(corridorStops).length

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
      onChangeRequestOpenChange(false)
    } catch (error) {
      console.error('Failed to submit change request', error)
      setChangeRequestError('Could not send that request — please try again.')
    } finally {
      setSubmittingChangeRequest(false)
    }
  }

  return (
    <>
      {/* The way into a day, now that opening one no longer costs the map.
        * Horizontally scrollable rather than wrapped: a two-month trip is
        * sixty of these, and sixty wrapped chips would push the map off the
        * screen — the exact failure the list below was given a height cap
        * for on 2026-08-19.
        *
        * Anchored to today since 2026-08-25 ("I want info about today,
        * tomorrow and so on"): the first thing on screen used to be day one,
        * which on day twelve is a town left a week and a half ago. See
        * dayStrip for what happens before and after the trip. */}
      <div
        className="flex items-center gap-1.5 overflow-x-auto border-b border-neutral-200 px-3 py-1.5 dark:border-neutral-800"
        data-testid="day-strip"
      >
        {strip.past.length > 0 && (
          <button
            type="button"
            data-testid="day-strip-show-past"
            className="chip chip-neutral shrink-0 px-2.5 py-1 text-xs whitespace-nowrap"
            onClick={() => setShowPastDays((shown) => !shown)}
          >
            {showPastDays ? 'Hide earlier' : `← ${strip.past.length} earlier`}
          </button>
        )}
        {daysMissingKeptStops > 0
          ? // The stored days do not describe these stops, so the strip
            // reads the board instead — see derivedDayStrip. Tapping one
            // offers the rebuild, because there is no day behind it to open.
            derivedDayStrip(routeStops, arrivals, today).map((chip) => (
              <button
                key={`stop:${chip.stop.id}`}
                type="button"
                data-testid={`day-strip-stop-${chip.stop.id}`}
                onClick={() => onRebuildOpenChange(true)}
                className={`chip shrink-0 px-3 py-1 text-xs whitespace-nowrap ${
                  chip.label === 'Today'
                    ? 'chip-accent'
                    : 'chip-neutral hover:bg-neutral-200 dark:hover:bg-neutral-700'
                }`}
              >
                <span className="font-medium">{chip.label}</span>
                <span className="ml-1.5 text-neutral-500 dark:text-neutral-400">
                  {chip.stop.name}
                </span>
              </button>
            ))
          : (showPastDays ? [...strip.past, ...strip.upcoming] : strip.upcoming).map(
          (chip) => (
            <button
              key={chip.day.id}
              type="button"
              data-testid={`day-strip-${chip.day.id}`}
              onClick={() => navigate(`/map/day/${chip.day.id}`)}
              className={`chip shrink-0 px-3 py-1 text-xs whitespace-nowrap ${
                chip.label === 'Today'
                  ? 'chip-accent'
                  : 'chip-neutral hover:bg-neutral-200 dark:hover:bg-neutral-700'
              } ${chip.day.date < today ? 'opacity-60' : ''}`}
            >
              <span className="font-medium">{chip.label}</span>
              <span className="ml-1.5 text-neutral-500 dark:text-neutral-400">
                {/* Today names what you are actually heading to, not what an
                  * older plan said you would sleep next to. Reported
                  * 2026-08-26: "'today' should reflect the closest not
                  * marked done activity. Now it's some other far away
                  * location" — it read "Castello Scaligero di Sirmione"
                  * from a van parked 200 km away at the Seiser Alm.
                  *
                  * `routeStops` is ordered from the van and excludes
                  * anything done (see orderStopsFromHere and lockedStops),
                  * so its first entry IS the closest one still to do. Only
                  * Today: the days after it are the plan's answer, and this
                  * one is the road's. */}
                {chip.label === 'Today' && nextStop
                  ? nextStop.name
                  : chip.day.overnight.name}
              </span>
            </button>
          ),
          )}
      </div>

      {/* The days on screen describe stops the traveler has not kept.
        *
        * Reported 2026-08-25: "The days on top are still som old irrelevant
        * stuff." They were — left over from an earlier full generation,
        * while six locked stops had no day at all. The automatic writer
        * cannot fix that on its own (those days carry researched detail, and
        * discarding it silently would be far worse), so the board says so
        * and offers the one button that can. */}
      {daysMissingKeptStops > 0 && (
        <div
          data-testid="days-out-of-step-banner"
          className="border-b border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
        >
          <p>
            These days are from an earlier plan — {daysMissingKeptStops} kept
            stop{daysMissingKeptStops === 1 ? ' is' : 's are'} not in them.
          </p>
          <button
            type="button"
            data-testid="days-out-of-step-rebuild"
            className="btn btn-sm btn-outline mt-1.5"
            onClick={() => onRebuildOpenChange(true)}
          >
            Rebuild day list
          </button>
        </div>
      )}

      {stale.length > 0 && (
        <div
          data-testid="stale-days-banner"
          className="border-b border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
        >
          <p>
            {stale.length} day{stale.length === 1 ? '' : 's'} in the list still
            belong{stale.length === 1 ? 's' : ''} to {stale.length === 1 ? 'a stop' : 'stops'} you
            removed from the route.
          </p>
          <button
            type="button"
            data-testid="tidy-stale-days"
            className="btn btn-sm btn-outline mt-1.5"
            disabled={tidying}
            onClick={() => void tidyStaleDays()}
          >
            {tidying ? 'Tidying…' : `Remove ${stale.length === 1 ? 'it' : 'them'}`}
          </button>
          {tidyError && (
            <p data-testid="tidy-stale-days-error" className="mt-1 text-red-700 dark:text-red-300">
              {tidyError}
            </p>
          )}
        </div>
      )}

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
          stops={committedStopsInRouteOrder(days, corridorStops)}
          addableStops={stopsAddableToRoute(corridorStops)}
          planBusy={planBusy}
          onSubmitted={markPlanSubmitted}
          onClose={() => onReorderOpenChange(false)}
        />
      )}

      {rebuildOpen && (
        <div
          data-testid="rebuild-days-panel"
          className="border-b border-neutral-200 bg-white p-4 text-sm dark:border-neutral-800 dark:bg-neutral-900"
        >
          <p>
            This replaces the day list with one built from your {routeStops.length}{' '}
            kept stop{routeStops.length === 1 ? '' : 's'}, in their current
            order.
          </p>
          <p className="mt-1 text-neutral-600 dark:text-neutral-300">
            Researched activities and restaurants on the existing days are
            discarded. Each new day fills itself in again when you open it.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="rebuild-days-confirm"
              className="btn btn-primary disabled:opacity-40"
              disabled={rebuilding}
              onClick={() => void rebuildDays()}
            >
              {rebuilding ? 'Rebuilding…' : 'Rebuild the days'}
            </button>
            <button
              type="button"
              data-testid="rebuild-days-cancel"
              className="btn btn-outline"
              disabled={rebuilding}
              onClick={() => onRebuildOpenChange(false)}
            >
              Cancel
            </button>
          </div>
          {rebuildError && (
            <p
              data-testid="rebuild-days-error"
              className="mt-2 text-sm text-red-600 dark:text-red-400"
            >
              {rebuildError}
            </p>
          )}
        </div>
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
              onClick={() => onChangeRequestOpenChange(false)}
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
/**
 * Why a rebuild produced nothing, in words rather than a slug.
 *
 * `has-detail` and `unchanged` are deliberately absent: an explicit rebuild
 * overrides both, so seeing either here would mean the option failed to
 * reach planSkeleton — worth saying plainly rather than mapping to a
 * reassuring sentence.
 */
function describeSkeletonSkip(skipped: SkeletonDecision['skipped']): string {
  switch (skipped) {
    case 'no-dates':
      return 'Set the trip’s start and end dates first.'
    case 'no-stops':
      return 'None of your kept stops has a country yet, so no days can be built from them.'
    case 'plan-busy':
      return 'A plan is already being generated — try again when it finishes.'
    case 'too-many-days':
      return 'That many stops would need more days than a trip can hold.'
    default:
      return 'Could not rebuild the days from the current stops.'
  }
}

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
