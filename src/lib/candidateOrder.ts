import { findCheapestBackboneLeg, sortAlongRoute, type LatLng } from '@rv/shared'
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
