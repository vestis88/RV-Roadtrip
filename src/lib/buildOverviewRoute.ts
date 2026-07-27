import type { LatLng } from '@rv/shared'

/**
 * The overview map's route geometry: which points the whole-trip driving route
 * threads through, and how to slice that sequence into requests the Directions
 * API will actually accept.
 *
 * Sibling to estimateHighlightsRoute.ts — same "pure, unit-testable route
 * geometry, no React or Firebase" shape, different problem: that one measures
 * detours off a fixed backbone, this one decides what the backbone *is* for a
 * trip whose days each carry a shortlist of candidate activities.
 */

/**
 * The Directions JS API caps a single request at 25 points total: an origin, a
 * destination, and up to 23 intermediate waypoints. A three-week trip routed
 * overnight-by-overnight with an activity anchor per day runs to ~40 points, so
 * chunking is the normal path here, not an edge case.
 */
export const MAX_DIRECTIONS_POINTS_PER_REQUEST = 25

/** Structurally satisfied by `Activity` from @rv/shared. */
export interface RouteActivityCandidate {
  lat: number
  lng: number
  rating?: number
  status?: string
}

export interface RouteDay {
  overnight: LatLng
  activities?: RouteActivityCandidate[]
}

/**
 * Generic in the point type so filtering a list of candidates doesn't narrow
 * them down to bare coordinates — the rating and status are the whole basis
 * for picking between them afterwards.
 */
function isUsablePoint<T extends LatLng>(point: T | undefined): point is T {
  return !!point && Number.isFinite(point.lat) && Number.isFinite(point.lng)
}

function toLatLng(point: RouteActivityCandidate): LatLng {
  return { lat: point.lat, lng: point.lng }
}

/**
 * The activity waypoint(s) the route should thread through for one day.
 *
 * Two modes, because the route has to be useful before the traveler has made
 * any decisions and has to obey them once they have:
 *
 * - Anything explicitly `selected` wins, all of it, in the order the day lists
 *   it. Selecting is the one signal that the traveler has actually committed to
 *   a place, so a route that ignored it would be arguing with them.
 * - Otherwise the day's best-rated candidate stands in as the initial
 *   suggestion — one point, not five, so a zoomed-out multi-week route stays a
 *   route rather than a scribble.
 *
 * `skipped` candidates are never anchors: an explicit rejection shouldn't be
 * able to come back as the suggestion just because it happens to be the
 * highest-rated thing left. A day where everything is skipped contributes no
 * anchor at all.
 *
 * Ratings are optional in the schema (Places doesn't have one for every place),
 * so an unrated candidate is ranked below any rated one and a day of entirely
 * unrated candidates falls through to the first — arbitrary but stable, and
 * specifically not a throw.
 */
export function selectDayAnchors(
  activities: RouteActivityCandidate[] | undefined,
): LatLng[] {
  const located = (activities ?? []).filter(isUsablePoint)
  if (located.length === 0) return []

  const selected = located.filter((activity) => activity.status === 'selected')
  if (selected.length > 0) return selected.map(toLatLng)

  const eligible = located.filter((activity) => activity.status !== 'skipped')
  if (eligible.length === 0) return []

  let best = eligible[0]
  for (const candidate of eligible.slice(1)) {
    if ((candidate.rating ?? 0) > (best.rating ?? 0)) best = candidate
  }
  return [toLatLng(best)]
}

/** Drops points that repeat the previous one — a zero-length leg routes to nothing. */
function dropConsecutiveDuplicates(points: LatLng[]): LatLng[] {
  return points.filter((point, i) => {
    if (i === 0) return true
    const previous = points[i - 1]
    return point.lat !== previous.lat || point.lng !== previous.lng
  })
}

/**
 * The full ordered point sequence for the trip: per day, the overnight stop
 * followed by that day's activity anchors.
 *
 * Rest days are included rather than filtered out (the straight polyline this
 * replaced skipped them): a rest day usually repeats the previous day's
 * overnight, which the duplicate check collapses, but it can still carry
 * activities worth routing through.
 */
export function buildOverviewRoutePoints(days: RouteDay[]): LatLng[] {
  const points: LatLng[] = []
  for (const day of days) {
    if (isUsablePoint(day.overnight)) {
      points.push({ lat: day.overnight.lat, lng: day.overnight.lng })
    }
    points.push(...selectDayAnchors(day.activities))
  }
  return dropConsecutiveDuplicates(points)
}

/**
 * Slices a point sequence into Directions-legal segments of at most
 * `maxPointsPerRequest` points each.
 *
 * Consecutive segments overlap by exactly one point — segment N's destination
 * is segment N+1's origin — so the concatenated renderings meet end to end
 * instead of leaving a straight-line gap across whatever the last leg was.
 *
 * Fewer than two points can't describe a drive, so it yields no segments at
 * all rather than a degenerate request.
 */
export function chunkRouteSegments(
  points: LatLng[],
  maxPointsPerRequest: number = MAX_DIRECTIONS_POINTS_PER_REQUEST,
): LatLng[][] {
  const max = Math.max(2, Math.floor(maxPointsPerRequest))
  if (points.length < 2) return []

  const segments: LatLng[][] = []
  let start = 0
  while (start < points.length - 1) {
    const end = Math.min(start + max, points.length)
    segments.push(points.slice(start, end))
    // Step back one so the next segment starts where this one ended.
    start = end - 1
  }
  return segments
}
