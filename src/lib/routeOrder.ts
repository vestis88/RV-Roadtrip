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
}

/** Identifies the set of stops an order describes. */
export function routeOrderKey(stops: { id: string }[]): string {
  return stops.map((stop) => stop.id).join(',')
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
