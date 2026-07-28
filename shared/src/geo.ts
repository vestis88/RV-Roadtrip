import type { LatLng } from './schemas.js'

const EARTH_RADIUS_KM = 6371

/**
 * Great-circle distance between two points, in kilometres.
 *
 * Lives here rather than in either app because both need it: the frontend
 * measures how far the traveler has drifted from the plan and estimates
 * candidate detours with it, and the backend's highlights-enrichment pass
 * uses the same detour maths to decide whether a web-search find is close
 * enough to the route to be worth offering. One implementation, so the two
 * can never disagree about what "100 km off the route" means.
 */
export function haversineDistanceKm(a: LatLng, b: LatLng): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const sinLat = Math.sin(dLat / 2)
  const sinLng = Math.sin(dLng / 2)
  const h =
    sinLat * sinLat +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h))
}

/**
 * Scalar projection of `point` onto the start→end line: 0 sits at start, 1 at
 * end, and values outside [0, 1] fall before start or past end. A planar
 * approximation (no great-circle math) — plenty accurate for ordering points
 * along a single trip's corridor, the same tradeoff estimateDetourKm already
 * makes with haversine distance.
 */
function projectAlongRoute(start: LatLng, end: LatLng, point: LatLng): number {
  const dx = end.lat - start.lat
  const dy = end.lng - start.lng
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return 0
  const px = point.lat - start.lat
  const py = point.lng - start.lng
  return (px * dx + py * dy) / lengthSquared
}

function isUsablePoint(point: LatLng | undefined): point is LatLng {
  return !!point && Number.isFinite(point.lat) && Number.isFinite(point.lng)
}

/**
 * The "ideal route" a trip's detours are measured against (and that the
 * review panel draws): start, every given point sorted by how far along the
 * start→end corridor it sits, then finish.
 *
 * Type-agnostic on purpose — callers extract the points they care about
 * (the frontend from HighlightRegion[], the backend from its own
 * RegionHighlight[]) and hand over plain coordinates.
 *
 * Sorted rather than trusting the caller's listed order: the highlights phase
 * works out a geographic corridor before listing anything, but never
 * guarantees its regions come out strictly sequenced along it — only
 * "roughly" so. A must-see promoted from a region that was out of that rough
 * order landed in the wrong spot in the backbone: a stop that belongs
 * mid-trip could sort in after the destination. Reported as: promoting a
 * highlight placed it after the destination on the map, with only a straight
 * line (no real route) to show for it — the backtracking a wrong order
 * produces is also exactly the kind of waypoint sequence that makes a
 * Directions request more likely to fail outright.
 *
 * A trip mid-edit can have a start/end point that hasn't been filled in yet;
 * ordering along a corridor needs both ends, so that case falls back to the
 * given order (dropping the incomplete point rather than passing NaN
 * coordinates through).
 */
export function buildRouteBackbone(
  start: LatLng | undefined,
  orderedPoints: LatLng[],
  end: LatLng | undefined,
): LatLng[] {
  const usableStart = isUsablePoint(start) ? start : undefined
  const usableEnd = isUsablePoint(end) ? end : undefined
  const sorted =
    usableStart && usableEnd
      ? [...orderedPoints].sort(
          (a, b) =>
            projectAlongRoute(usableStart, usableEnd, a) -
            projectAlongRoute(usableStart, usableEnd, b),
        )
      : orderedPoints

  return [usableStart, ...sorted, usableEnd].filter(isUsablePoint)
}

/**
 * Which backbone leg (A, B) is cheapest to insert `candidate` into — the
 * index `i` such that A = backbone[i], B = backbone[i + 1] — minimising
 * haversine(A, candidate) + haversine(candidate, B) - haversine(A, B) over
 * every leg. Shared by the haversine detour estimate below and by the
 * real-Directions detour lookup (which needs to know exactly which two
 * backbone points to route the candidate between, not just the resulting
 * number) — one selection, so the two never pick a different leg for the
 * same candidate. Returns null for a backbone too short to have a leg at all.
 */
export function findCheapestBackboneLeg(
  candidate: LatLng,
  backbone: LatLng[],
): number | null {
  if (backbone.length < 2) return null

  let bestIndex = 0
  let bestDetour = Infinity
  for (let i = 0; i < backbone.length - 1; i++) {
    const a = backbone[i]
    const b = backbone[i + 1]
    const viaCandidate =
      haversineDistanceKm(a, candidate) + haversineDistanceKm(candidate, b)
    const detour = viaCandidate - haversineDistanceKm(a, b)
    if (detour < bestDetour) {
      bestDetour = detour
      bestIndex = i
    }
  }
  return bestIndex
}

/**
 * Cheapest-insertion estimate of what visiting `candidate` costs on top of
 * the backbone: for the cheapest leg (A, B), how much longer A→candidate→B is
 * than A→B. That's the extra distance of slotting the stop into wherever it
 * fits best, which is what "detour" means to a traveler looking at a
 * shortlist.
 *
 * Straight-line (haversine) rather than real driving distance on purpose:
 * this runs client-side over every candidate on every priority change, and a
 * Directions call per candidate would be both slow and expensive for a figure
 * whose only job is to make candidates comparable to each other. It reads low
 * against real roads (especially around fjords and mountains) — an ordering
 * hint, not a routing promise. Callers that want the real figure use
 * findCheapestBackboneLeg themselves to know which two points to route a
 * candidate between, then ask Directions for that leg specifically.
 */
export function estimateDetourKm(
  candidate: LatLng,
  backbone: LatLng[],
): number {
  const legIndex = findCheapestBackboneLeg(candidate, backbone)
  if (legIndex === null) return 0

  const a = backbone[legIndex]
  const b = backbone[legIndex + 1]
  const viaCandidate =
    haversineDistanceKm(a, candidate) + haversineDistanceKm(candidate, b)
  const detour = viaCandidate - haversineDistanceKm(a, b)

  // Floating-point noise can push an exactly-on-the-line point microscopically
  // negative; a negative detour is meaningless either way.
  return Math.max(0, detour)
}
