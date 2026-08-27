import {
  findCheapestBackboneLeg,
  projectAlongRoute,
  sortAlongRoute,
  type LatLng,
} from '@rv/shared'
import type { CorridorStopWithId } from '../hooks/useCorridorStops'

/**
 * The candidate list, in the order you actually drive past things.
 *
 * Reported 2026-08-24: *"The list is not updating according to the logical
 * chronological order, not even when locked in."*
 *
 * The list was sorted by `sortAlongRoute`, which projects every stop onto the
 * straight line from the trip's start to its end and sorts by that one
 * number. For an out-and-back or a loop — Bavaria, across Switzerland, down
 * into the Dolomites, home — that scalar says almost nothing: two stops on
 * opposite sides of the loop project to the same place, and the drive order
 * is not recoverable from it at all. This codebase already knows that;
 * `guessedOrder` carries a note about a scalar projection sending a trip
 * north through Sweden to reach Estonia.
 *
 * The real order was sitting right there unused. `routeStops` IS the driving
 * order — Google's optimisation, or the traveler's own after a manual
 * reorder — and it is what draws the route line, the leg rows and the
 * arrival dates. The list was the one thing re-deriving a worse order from
 * scratch, which is why it disagreed with everything around it.
 *
 * So kept stops take their position from the route, and a candidate that is
 * not on the route yet is placed where it would go: between the two backbone
 * points it is cheapest to insert between. That is `findCheapestBackboneLeg`,
 * the same function behind the "≈+41 km" badge on the card — so a stop's
 * place in the list and the detour it advertises can never disagree about
 * which leg it belongs to.
 */
/**
 * The kept stops in the order they will be driven, from where the van is.
 *
 * Requested 2026-08-26: "I feel it should start working out the order from
 * my position, just treat that as the current starting point."
 *
 * `sortAlongRoute` alone is not enough for that, and the reason is the whole
 * bug. It sorts by scalar projection onto the origin→end line, and a stop
 * BEHIND the origin projects NEGATIVE — so it sorts before everything ahead.
 * Standing at the Seiser Alm with Verona as the end point, Kronplatz is
 * north-east while the route runs south-west, so it projected to a negative
 * number and was presented as the next stop. Reported exactly that way:
 * "putting Kronplatz ahead of Seiser Alm, even though we are at Seiser Alm."
 *
 * A stop you have passed, or that lies the other way, is still yours — it is
 * just not next. So the ones ahead come first in projection order, and the
 * ones behind follow, in the order you would meet them going back.
 */
export function orderStopsFromHere<T>(
  origin: LatLng,
  end: LatLng,
  stops: T[],
  pointOf: (stop: T) => LatLng,
): T[] {
  const measured = stops.map((stop, index) => ({
    stop,
    index,
    along: projectAlongRoute(origin, end, pointOf(stop)),
  }))
  const ahead = measured.filter((entry) => entry.along >= 0)
  const behind = measured.filter((entry) => entry.along < 0)
  // Behind is sorted DESCENDING: the least-far-back comes first, because
  // that is the one you would reach first if you turned around.
  const order = [
    ...ahead.sort((a, b) => a.along - b.along || a.index - b.index),
    ...behind.sort((a, b) => b.along - a.along || a.index - b.index),
  ]
  return order.map((entry) => entry.stop)
}

export function orderCandidatesByRoute(input: {
  candidates: CorridorStopWithId[]
  /** Kept stops in driving order — see ExploreMapScreen's routeStops. */
  routeStops: { id: string }[]
  /** [origin, ...routeStops, end] — what the route line is drawn through. */
  backbone: LatLng[]
  /** Only used when there is no route yet. */
  startPoint?: LatLng
  endPoint?: LatLng
}): CorridorStopWithId[] {
  const { candidates, routeStops, backbone, startPoint, endPoint } = input

  // No route means no route order, and inventing one would be the very
  // mistake this replaces. The straight-line projection is at least a stable,
  // roughly north-to-south reading of a corridor nobody has committed to.
  if (routeStops.length === 0 || backbone.length < 2) {
    return sortAlongRoute(startPoint, endPoint, candidates, (candidate) => ({
      lat: candidate.lat,
      lng: candidate.lng,
    }))
  }

  const routeIndexById = new Map(
    routeStops.map((stop, index) => [stop.id, index]),
  )

  const positionOf = (candidate: CorridorStopWithId): number => {
    // backbone[0] is the origin, so the stop at routeStops[i] is backbone[i+1].
    const onRoute = routeIndexById.get(candidate.id)
    if (onRoute !== undefined) return onRoute + 1

    const leg = findCheapestBackboneLeg(
      { lat: candidate.lat, lng: candidate.lng },
      backbone,
    )
    // Half a step past the backbone point the leg starts at, so an unkept
    // candidate sits between the two stops it would be driven between rather
    // than tying with either of them.
    return leg === null ? backbone.length : leg + 0.5
  }

  return [...candidates]
    .map((candidate, index) => ({
      candidate,
      position: positionOf(candidate),
      // Original index as the tie-break, so the sort is stable across
      // renders — several unkept candidates routinely share a leg, and a
      // list that reshuffled them on every snapshot would be unusable.
      index,
    }))
    .sort((a, b) => a.position - b.position || a.index - b.index)
    .map((entry) => entry.candidate)
}
