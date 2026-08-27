import type { CorridorStopWithId } from '../hooks/useCorridorStops'
import type { TripDayWithId } from '../hooks/useTripDays'

/**
 * Which stops "Edit route" can reorder, and which it can add.
 *
 * Extracted from PlanStrip on 2026-08-24 when the board took over rendering
 * the actions row: the button lives in one component and the panel it opens
 * in another, and both have to agree about whether there is anything to
 * edit. Two copies of that rule would drift into a button that opens an
 * empty panel.
 */

/**
 * Committed stops in the order their days fall.
 *
 * `corridorStops` carries no sequence of its own — `linkedDayIds` ties each
 * stop back to real, ordered days, so the days ARE the order. An empty
 * `days` can produce no order at all (every stop ties on Infinity), which
 * surfaced as an intermittently wrong first stop in the reorder panel, so it
 * yields nothing rather than a guess.
 */
export function committedStopsInRouteOrder(
  days: TripDayWithId[],
  corridorStops: CorridorStopWithId[],
): { id: string; name: string; earliestIndex: number }[] {
  const dayIndexById = new Map(days.map((day) => [day.id, day.index]))
  return (days.length === 0 ? [] : corridorStops)
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
}

/**
 * Locked stops with no day yet — a traveler-placed pin or a locked rescan
 * find. These are what reconciliation can add into the route.
 */
export function stopsAddableToRoute(
  corridorStops: CorridorStopWithId[],
): { id: string; name: string }[] {
  return corridorStops
    .filter(
      (stop) =>
        stop.status === 'locked' &&
        stop.linkedDayIds.length === 0 &&
        // Not one you have already been to. A done stop needs no day and
        // cannot be "added to the route" — it is behind you. Counting them
        // made the out-of-step banner promise to fix thirteen stops while
        // the rebuild panel beneath it said six, which is how the same
        // screen ended up contradicting itself (2026-08-26).
        !stop.doneAt,
    )
    .map((stop) => ({ id: stop.id, name: stop.name }))
}

/** Whether "Edit route" has anything to offer: something to reorder, or to add. */
export function canEditRoute(
  days: TripDayWithId[],
  corridorStops: CorridorStopWithId[],
): boolean {
  return (
    committedStopsInRouteOrder(days, corridorStops).length > 1 ||
    stopsAddableToRoute(corridorStops).length > 0
  )
}
