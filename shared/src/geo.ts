import type { LatLng } from './schemas.js'

const EARTH_RADIUS_KM = 6371

/**
 * Real driving distance is longer than the great-circle distance because
 * roads bend around terrain and borders; 1.35x is a reasonable average for
 * long-distance European routes.
 *
 * Assumed average speed is for a 3,500 kg RV mixing motorway and other
 * roads — deliberately below a car's, because the whole app is about
 * pacing an RV.
 *
 * Both live here rather than in the backend (where they started, in
 * functions/src/routesApi.ts) for the same reason haversineDistanceKm does:
 * the client now estimates drive time too, and two copies of "how fast does
 * this thing go" is exactly the sort of pair that drifts apart and leaves
 * the traveler reading one number in the candidate list and a different one
 * on the generated plan.
 */
export const ROAD_DISTANCE_FACTOR = 1.35
export const ASSUMED_AVG_SPEED_KMH = 75

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
export function projectAlongRoute(
  start: LatLng,
  end: LatLng,
  point: LatLng,
): number {
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
  return routeBackboneFrom(
    start,
    sortAlongRoute(start, end, orderedPoints, (point) => point),
    end,
  )
}

/**
 * The same start→middle→end shape, taking the middle points in the order
 * given instead of sorting them.
 *
 * For a caller that already has a BETTER order than the projection above can
 * produce — explore mode, once Google has reordered the stops against real
 * roads (and real ferries). The projection is a scalar onto the straight
 * start→end line and cannot know the sea is in the way: it sorted a stop in
 * northern Sweden before one on Saaremaa, and the resulting fixed waypoint
 * sequence could only be driven around the Gulf of Bothnia.
 */
export function routeBackboneFrom(
  start: LatLng | undefined,
  middle: LatLng[],
  end: LatLng | undefined,
): LatLng[] {
  return [
    isUsablePoint(start) ? start : undefined,
    ...middle.filter(isUsablePoint),
    isUsablePoint(end) ? end : undefined,
  ].filter(isUsablePoint)
}

/**
 * The same start→end ordering buildRouteBackbone applies to its own middle
 * points, exposed for anything that needs the order without needing the
 * backbone: the explore list renders candidates in the order you would
 * actually drive past them, which is a different question from which of
 * them the route is drawn through.
 *
 * Generic in the item so a caller keeps its own objects (with ids, names and
 * everything else) rather than getting bare coordinates back.
 *
 * Falls back to the given order when either end of the trip is missing, for
 * the reason buildRouteBackbone's own doc comment gives: ordering along a
 * corridor needs both ends, and a trip mid-edit may not have them yet.
 */
export function sortAlongRoute<T>(
  start: LatLng | undefined,
  end: LatLng | undefined,
  items: T[],
  pointOf: (item: T) => LatLng,
): T[] {
  const usableStart = isUsablePoint(start) ? start : undefined
  const usableEnd = isUsablePoint(end) ? end : undefined
  if (!usableStart || !usableEnd) return [...items]
  return [...items].sort(
    (a, b) =>
      projectAlongRoute(usableStart, usableEnd, pointOf(a)) -
      projectAlongRoute(usableStart, usableEnd, pointOf(b)),
  )
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

/**
 * Roughly how many minutes of driving a straight-line distance costs, at the
 * RV's assumed average speed.
 *
 * Deliberately does NOT apply ROAD_DISTANCE_FACTOR, even though the roads
 * really are ~1.35x longer than the straight line. The only caller today
 * displays this next to the same straight-line kilometres it was computed
 * from (see ExploreCandidateCard's detour badge), and a traveler reading
 * "+12 km · +16 min" will divide the two, get 45 km/h, and conclude the app
 * is broken. Both figures being consistent lower bounds is more useful than
 * one being adjusted and the other not — the pair understates together, and
 * says so.
 *
 * If a caller ever needs a real driving figure rather than a comparable one,
 * that is what computeRouteLeg (server) and the Directions legs (client)
 * are for — this is an ordering hint, the same as estimateDetourKm.
 */
export function estimateDriveMinutes(straightLineKm: number): number {
  if (!Number.isFinite(straightLineKm) || straightLineKm <= 0) return 0
  return (straightLineKm / ASSUMED_AVG_SPEED_KMH) * 60
}

/**
 * A rectangle of the world, in the same four numbers Google Maps reports a
 * viewport as.
 *
 * Added 2026-09-05, on: *"Can't you do it some other way completely? Don't
 * lock yourself to a circle if a rectangle would work better. Google must
 * have some native understanding of searching a defined area!"*
 *
 * They do, and it was being thrown away. The map hands us the visible
 * rectangle; `visibleRadiusKm` measured its half-diagonal and discarded the
 * shape, so a search over a landscape view looked for places in a circle
 * that covered the top and bottom of the screen and none of the sides —
 * while the button said "this area" and the panel said "what I can see".
 */
export interface MapBounds {
  north: number
  south: number
  east: number
  west: number
}

/** Whether a point is inside the rectangle. */
export function boundsContain(bounds: MapBounds, point: LatLng): boolean {
  if (point.lat > bounds.north || point.lat < bounds.south) return false
  // A viewport that crosses the antimeridian has east < west, and the
  // longitudes inside it are the ones OUTSIDE that numeric interval. Rare in
  // Europe and free to be right about.
  return bounds.east >= bounds.west
    ? point.lng >= bounds.west && point.lng <= bounds.east
    : point.lng >= bounds.west || point.lng <= bounds.east
}

export function boundsCenter(bounds: MapBounds): LatLng {
  return {
    lat: (bounds.north + bounds.south) / 2,
    lng:
      bounds.east >= bounds.west
        ? (bounds.east + bounds.west) / 2
        : normaliseLng((bounds.east + bounds.west) / 2 + 180),
  }
}

function normaliseLng(lng: number): number {
  return ((((lng + 180) % 360) + 360) % 360) - 180
}

/**
 * Half the rectangle's diagonal — centre to corner, in kilometres.
 *
 * The same measurement the circle used, kept because it is what the cost cap
 * is written in: a rectangle whose corner is 150 km from its centre costs
 * what the old 150 km circle cost, and rather more of it is ground the
 * traveler can actually see.
 */
export function boundsHalfDiagonalKm(bounds: MapBounds): number {
  return haversineDistanceKm(boundsCenter(bounds), {
    lat: bounds.north,
    lng: bounds.east,
  })
}

/**
 * The same rectangle, shrunk about its centre until its corner is no further
 * than `maxHalfDiagonalKm` away. Returns it unchanged when it already fits.
 */
export function shrinkBoundsToFit(
  bounds: MapBounds,
  maxHalfDiagonalKm: number,
): MapBounds {
  if (boundsHalfDiagonalKm(bounds) <= maxHalfDiagonalKm) return bounds
  const centre = boundsCenter(bounds)
  const fullLat = (bounds.north - bounds.south) / 2
  const fullLng =
    (bounds.east >= bounds.west
      ? bounds.east - bounds.west
      : bounds.east + 360 - bounds.west) / 2

  // Iterated rather than solved, because scaling the degrees is not linear
  // in the kilometres: shrinking the latitude span moves the corner toward
  // the equator, where a degree of longitude is wider, so one pass of naive
  // scaling overshoots. Three passes settle it to well inside a kilometre,
  // and there is nothing here worth a closed form.
  let scale = maxHalfDiagonalKm / boundsHalfDiagonalKm(bounds)
  let scaled = bounds
  for (let pass = 0; pass < 3; pass++) {
    scaled = {
      north: centre.lat + fullLat * scale,
      south: centre.lat - fullLat * scale,
      east: normaliseLng(centre.lng + fullLng * scale),
      west: normaliseLng(centre.lng - fullLng * scale),
    }
    const reached = boundsHalfDiagonalKm(scaled)
    if (reached === 0) break
    scale *= maxHalfDiagonalKm / reached
  }
  return scaled
}
