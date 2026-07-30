import type { ActivityTimeOfDay, DaySlot, LatLng, Meal } from '@rv/shared'

/**
 * The overview map's route geometry: which points the whole-trip driving route
 * threads through, and how to slice that sequence into requests the Directions
 * API will actually accept. Pure, unit-testable route geometry — no React or
 * Firebase.
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
  timeOfDay?: ActivityTimeOfDay
}

/** Structurally satisfied by `Restaurant` from @rv/shared. */
export interface RouteRestaurantCandidate {
  lat: number
  lng: number
  status?: string
  meal?: Meal
}

export interface RouteDay {
  overnight: LatLng
  /** `TripDay.drive?.slot` — absent for rest days and days with no drive at
   * all, in which case buildDayRoutePoints treats it like an 'evening' drive
   * (see that function's own comment). */
  driveSlot?: DaySlot
  activities?: RouteActivityCandidate[]
  restaurants?: RouteRestaurantCandidate[]
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

function selectedMealPoints(
  restaurants: RouteRestaurantCandidate[],
  meal: Meal,
): LatLng[] {
  return restaurants
    .filter(
      (r): r is RouteRestaurantCandidate & LatLng =>
        r.meal === meal && r.status === 'selected' && isUsablePoint(r),
    )
    .map(toLatLng)
}

function selectedTimeOfDayPoints(
  activities: RouteActivityCandidate[],
  timeOfDay: ActivityTimeOfDay,
): LatLng[] {
  return activities
    .filter(
      (activity) =>
        activity.status === 'selected' &&
        isUsablePoint(activity) &&
        // Absent means 'all-day' (see activitySchema's own comment) — a
        // selection made before this feature existed, or one the traveler
        // just didn't bother tagging, still counts as a route waypoint.
        (activity.timeOfDay ?? 'all-day') === timeOfDay,
    )
    .map(toLatLng)
}

/**
 * One day's route waypoints, in visiting order.
 *
 * Two modes, same reasoning as `selectDayAnchors`: the route has to be
 * useful before the traveler has made any decisions, and has to obey them
 * once they have.
 *
 * - **Nothing selected yet** (no restaurant, no activity): falls back to
 *   `selectDayAnchors`' single best-rated-activity placeholder, exactly as
 *   before this feature — there's no meal/time-of-day signal to sequence by.
 * - **Once anything is selected**: sequences breakfast → morning activity →
 *   lunch → evening activity → dinner → night activity → overnight,
 *   reordered around the day's drive per `driveSlot` — this is the
 *   traveler-specified order: "Breakfast, morning activity if selected,
 *   lunch, evening activity if selected, dinner, night activity if
 *   selected, overnight stop (if evening drive is selected). If morning
 *   drive is chosen, then it should be breakfast, overnight stop and then
 *   according to above." A midday drive splits the day the same way: the
 *   morning half (breakfast, morning activity) happens before the drive,
 *   the rest after. A day with no drive at all (a rest day, or the trip's
 *   first day) uses the same order as an evening drive — the overnight is
 *   already where the traveler is, so it reads naturally as the day's last
 *   stop rather than its first.
 * - An activity selected but never tagged with a time of day (everything
 *   selected before this feature existed, or simply not tagged) is treated
 *   as `'all-day'` and grouped into the morning slot — present in the
 *   route, just without a specific place to sort it.
 */
export function buildDayRoutePoints(day: RouteDay): LatLng[] {
  const overnight = isUsablePoint(day.overnight)
    ? [{ lat: day.overnight.lat, lng: day.overnight.lng }]
    : []
  const restaurants = day.restaurants ?? []
  const activities = day.activities ?? []

  const anySelected =
    restaurants.some((r) => r.status === 'selected') ||
    activities.some((a) => a.status === 'selected')
  if (!anySelected) {
    return dropConsecutiveDuplicates([...overnight, ...selectDayAnchors(activities)])
  }

  const breakfast = selectedMealPoints(restaurants, 'breakfast')
  const lunch = selectedMealPoints(restaurants, 'lunch')
  const dinner = selectedMealPoints(restaurants, 'dinner')
  const morningActivity = [
    ...selectedTimeOfDayPoints(activities, 'morning'),
    ...selectedTimeOfDayPoints(activities, 'all-day'),
  ]
  const eveningActivity = selectedTimeOfDayPoints(activities, 'evening')
  const nightActivity = selectedTimeOfDayPoints(activities, 'night')

  const sequence =
    day.driveSlot === 'morning'
      ? [breakfast, overnight, morningActivity, lunch, eveningActivity, dinner, nightActivity]
      : day.driveSlot === 'midday'
        ? [breakfast, morningActivity, overnight, lunch, eveningActivity, dinner, nightActivity]
        : [breakfast, morningActivity, lunch, eveningActivity, dinner, nightActivity, overnight]

  return dropConsecutiveDuplicates(sequence.flat())
}

/**
 * The full ordered point sequence for the trip: per day, `buildDayRoutePoints`.
 *
 * Rest days are included rather than filtered out (the straight polyline this
 * replaced skipped them): a rest day usually repeats the previous day's
 * overnight, which the duplicate check collapses, but it can still carry
 * activities worth routing through.
 */
export function buildOverviewRoutePoints(days: RouteDay[]): LatLng[] {
  return dropConsecutiveDuplicates(days.flatMap((day) => buildDayRoutePoints(day)))
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
