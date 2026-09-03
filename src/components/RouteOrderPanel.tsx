import type { CorridorStopWithId } from '../hooks/useCorridorStops'
import type { ArrivalEstimate } from '../lib/arrivalEstimates'
import { labelForDate } from '../lib/dayStrip'

/**
 * The order the route is driven in, arranged by hand.
 *
 * Replaces the old "Edit route" panel, which was a relic of the frozen-plan
 * model twice over (2026-09-01):
 *
 *  - it listed `status === 'committed'` stops — what a full GENERATION
 *    writes — ordered by the day index of that generation, so on a trip
 *    curated since it showed an old route and not the current one, which is
 *    exactly how it was reported;
 *  - and it submitted through `reconcileCorridor`, the paid server pass that
 *    rewrites every day and every date, for what is now a free client-side
 *    reordering the skeleton writer picks up on its own.
 *
 * Requested in its place: *"I don't like the current order arrows, as it
 * doesn't show how it changes things. So retire the arrows, but keep the
 * list as the manual sorting of the order. It should have a button to reset
 * to full automatic google ordering."*
 *
 * So the arrows moved off the cards and into a list where moving one stop
 * shows the consequence: every row carries the day it would be reached, and
 * those dates re-derive as the order changes. That is the answer to "it
 * doesn't show how it changes things" — the change is the dates.
 */
export function RouteOrderPanel({
  stops,
  arrivals,
  manual,
  today,
  onMove,
  onReset,
  onClose,
}: {
  /** The locked stops, in the order they will actually be driven. */
  stops: CorridorStopWithId[]
  /** When each is reached, by stop id — recomputed as the order changes. */
  arrivals: Map<string, ArrivalEstimate>
  /** Whether this order is the traveler's rather than Google's. */
  manual: boolean
  today: string
  onMove: (stopId: string, delta: -1 | 1) => void
  onReset: () => void
  onClose: () => void
}) {
  return (
    <div
      data-testid="route-order-panel"
      className="border-b border-neutral-200 bg-white p-4 text-sm dark:border-neutral-800 dark:bg-neutral-900"
    >
      <p className="text-neutral-600 dark:text-neutral-300">
        {manual
          ? 'Your own order. Google will not rearrange it until you reset.'
          : 'Google’s order, worked out from where you are. Move anything to take it over.'}
      </p>

      <ol className="mt-2 space-y-1" data-testid="route-order-list">
        {stops.map((stop, index) => {
          const arrival = arrivals.get(stop.id)
          return (
            <li
              key={stop.id}
              data-testid={`route-order-row-${stop.id}`}
              className="flex items-center gap-2 rounded-lg border border-neutral-200 p-2 dark:border-neutral-800"
            >
              <span className="w-5 shrink-0 text-xs text-neutral-500 dark:text-neutral-400">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-neutral-900 dark:text-white">
                  {stop.name}
                </span>
                {/* The consequence of the arrangement, on the row being
                  * arranged. */}
                {arrival && (
                  <span
                    data-testid={`route-order-when-${stop.id}`}
                    className="block text-xs text-neutral-500 dark:text-neutral-400"
                  >
                    {labelForDate(arrival.date, today)}
                  </span>
                )}
              </span>
              <button
                type="button"
                data-testid={`route-order-up-${stop.id}`}
                className="btn btn-sm btn-outline disabled:opacity-30"
                disabled={index === 0}
                aria-label={`Move ${stop.name} earlier`}
                onClick={() => onMove(stop.id, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                data-testid={`route-order-down-${stop.id}`}
                className="btn btn-sm btn-outline disabled:opacity-30"
                disabled={index === stops.length - 1}
                aria-label={`Move ${stop.name} later`}
                onClick={() => onMove(stop.id, 1)}
              >
                ↓
              </button>
            </li>
          )
        })}
      </ol>

      <div className="mt-3 flex flex-wrap gap-2">
        {/* Only offered when there is something to undo — resetting an order
          * Google already owns does nothing and says nothing. */}
        {manual && (
          <button
            type="button"
            data-testid="route-order-reset"
            className="btn btn-outline"
            onClick={onReset}
          >
            Back to automatic order
          </button>
        )}
        <button
          type="button"
          data-testid="route-order-done"
          className="btn btn-primary"
          onClick={onClose}
        >
          Done
        </button>
      </div>
    </div>
  )
}

export default RouteOrderPanel
