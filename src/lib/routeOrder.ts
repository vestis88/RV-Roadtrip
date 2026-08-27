/**
 * Applying the driving order Google worked out, without setting off the loop
 * that made the route visibly thrash.
 *
 * The trap, and it is written up in ExploreMapScreen's own comments because
 * this is the second time it has been walked into: `<DirectionsRoute>` lists
 * its `points` in an effect dependency array, so a new array identity on
 * every render means a new Directions request on every render. Feeding
 * Google's answer back in as the next request's input closes that circuit —
 * each reply produced a fresh array, which re-fired the request, which
 * cancelled the one in flight. Reported as the route jumping around and
 * "Driving time unavailable", which is exactly what a permanently cancelled
 * Directions call looks like.
 *
 * Two rules come out of that, and both live here so they cannot drift apart:
 *
 * 1. The request's input is always the STABLE guess, never the answer. What
 *    Google returns is drawn (an optimized result carries its own reordered
 *    legs) and used for everything downstream, but it never becomes the next
 *    question.
 * 2. Applying an order that changes nothing returns the very same array,
 *    identity included. An identity permutation is the normal steady state —
 *    once the order is right, Google keeps agreeing with it — so this is the
 *    case that must not allocate.
 */

/** An order is a list of positions; it only means anything for the exact set of stops it was computed for. */
export interface RouteOrder {
  key: string
  order: number[]
  /**
   * The traveler arranged this, not Google (2026-08-23).
   *
   * Requested: "Google should still optimize the route by default, but there
   * should be some manual override possible, that can then also be reset."
   *
   * It has to be recorded rather than inferred, because the two orders are
   * indistinguishable once stored — a hand-made order and an optimised one
   * are both just a list of positions. Without this flag the next Directions
   * reply would silently overwrite the traveler's arrangement with Google's,
   * and the override would appear to work until the map next refreshed.
   */
  manual?: boolean
}

/** Identifies the set of stops an order describes. */
export function routeOrderKey(
  stops: { id: string }[],
  /**
   * Where the order was worked out FROM, when that is not the trip's start
   * point — see ExploreMapScreen's originPoint.
   *
   * Part of the key since 2026-08-26, and it is a correctness fix rather
   * than a refinement. An order is only an answer to "best order from HERE";
   * keyed on the stops alone, an order optimised at a lay-by in the
   * Dolomites was indistinguishable from one optimised at the start line and
   * got applied just the same. The origin is already snapped to a ~1 km grid
   * (quantisePosition), so this changes when the van has genuinely moved and
   * not once per GPS fix.
   */
  from?: { lat: number; lng: number },
): string {
  const ids = stops.map((stop) => stop.id).join(',')
  if (!from) return ids
  return `${from.lat.toFixed(2)},${from.lng.toFixed(2)}|${ids}`
}

/**
 * `guess` reordered by `applied`, or `guess` itself when the order does not
 * apply or does not change anything.
 */
export function applyRouteOrder<T extends { id: string }>(
  guess: T[],
  applied: RouteOrder | null,
  key: string,
): T[] {
  if (!applied || applied.key !== key) return guess
  if (applied.order.length !== guess.length) return guess
  // Identity: the steady state. Returning `guess` unchanged is what keeps the
  // render that follows from producing a new array and asking Google again.
  if (applied.order.every((position, index) => position === index)) return guess

  const reordered = applied.order.map((position) => guess[position])
  return reordered.every((stop) => stop !== undefined) ? reordered : guess
}

/**
 * Whether a freshly-received order is worth storing — false when it says the
 * same thing as the one already held, so no state changes and no render
 * follows.
 */
export function isNewRouteOrder(
  held: RouteOrder | null,
  key: string,
  order: number[],
): boolean {
  if (!held || held.key !== key) return true
  if (held.order.length !== order.length) return true
  return held.order.some((position, index) => position !== order[index])
}

/**
 * A hand-made order, for the stops as they currently stand.
 *
 * `positions` is the new arrangement expressed as indices INTO the guess —
 * the same shape Google's `waypoint_order` uses — so `applyRouteOrder` needs
 * to know nothing about where an order came from.
 */
export function manualRouteOrder(key: string, positions: number[]): RouteOrder {
  return { key, order: positions, manual: true }
}

/**
 * Whether Google may reorder this route.
 *
 * False once the traveler has arranged it themselves: the whole point of an
 * override is that the next reply does not undo it. Resetting is simply
 * dropping the stored order, after which this is true again.
 *
 * It does NOT care where the route starts from any more. That was tried on
 * 2026-08-25 — optimisation disabled while routing from the traveler's own
 * position, to stop the order shifting as they drove — and it was wrong in a
 * way only the road showed: with Google not reordering, the order fell back
 * to `guessedOrder`, a straight-line projection from the trip's START point,
 * which ignores where the van is entirely. Reported the next morning: "it's
 * jumping around, for some reason putting Kronplatz ahead of Seiser Alm,
 * even though we are at Seiser Alm."
 *
 * The answer was not to stop optimising but to optimise from the right
 * place: "I feel it should start working out the order from my position,
 * just treat that as the current starting point." The order moving as the
 * trip is travelled is then correct rather than thrash — it is a different
 * question with a different answer — and `routeOrderKey` carries the origin
 * so a stale answer is never applied to a new one.
 */
export function mayOptimize(held: RouteOrder | null): boolean {
  return !held?.manual
}
