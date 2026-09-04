import type { CorridorStopWithId } from '../hooks/useCorridorStops'

/**
 * Which stops "Edit route" can reorder, and which it can add.
 *
 * Extracted from PlanStrip on 2026-08-24 when the board took over rendering
 * the actions row: the button lives in one component and the panel it opens
 * in another, and both have to agree about whether there is anything to
 * edit. Two copies of that rule would drift into a button that opens an
 * empty panel — which is exactly what happened anyway when the panel moved
 * on and the gate did not, so `canEditRoute` now asks the panel's own list.
 */

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

/**
 * Whether "Edit route" has anything to offer.
 *
 * Asks about the same stops the panel lists (2026-09-03). The panel moved to
 * the kept stops in driving order on 2026-09-01 — that was the whole point of
 * the report that it "contains an old route, not the current" — but this
 * gate was left behind asking the frozen-plan question: are there committed
 * stops from a generation, or kept stops with no day yet?
 *
 * On a trip curated rather than generated, both are eventually no: nothing
 * is 'committed', and the skeleton writer gives every kept stop a
 * `linkedDayIds` as soon as it writes the days. So the button vanished from
 * precisely the trips whose order is worth arranging by hand, while the
 * panel behind it had a full list.
 */
export function canEditRoute(routeStops: { id: string }[]): boolean {
  return routeStops.length > 1
}
