import type { LatLng } from '@rv/shared'
import { haversineDistanceKm } from './executionMode'

export type HighlightPriority =
  'must-see' | 'worth-a-detour' | 'nice-if-convenient'

export interface HighlightCandidateStop {
  town: string
  country: string
  why: string
  priority: HighlightPriority
  /** Geocoded server-side (see functions/src/prompts/planTrip.ts) — absent when geocoding failed. */
  lat?: number
  lng?: number
}

export interface HighlightRegion {
  region: string
  country: string
  reasoning: string
  candidateStops: HighlightCandidateStop[]
}

/** Narrowed form of a candidate that actually has coordinates. */
export type LocatedStop = HighlightCandidateStop & LatLng

export function hasLocation(stop: HighlightCandidateStop): stop is LocatedStop {
  return typeof stop.lat === 'number' && typeof stop.lng === 'number'
}

/**
 * Scalar projection of `point` onto the start→end line: 0 sits at start, 1 at
 * end, and values outside [0, 1] fall before start or past end. A planar
 * approximation (no great-circle math) — plenty accurate for ordering
 * candidates along a single trip's corridor, the same tradeoff
 * estimateDetourKm already makes with haversine distance.
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

/**
 * The "ideal route" the review panel measures detours against (and draws):
 * start, every must-see candidate that has coordinates — sorted by how far
 * along the start→end corridor each one sits — then finish.
 *
 * Sorted rather than trusting the highlights phase's own region order (the
 * first version of this): HIGHLIGHTS_SYSTEM_PROMPT's step 1 works out a
 * geographic corridor before listing anything, but never guarantees the
 * regions themselves come out strictly sequenced along it — only "roughly"
 * so. A must-see promoted from a region that was out of that rough order
 * landed in the wrong spot in the backbone: a stop that belongs mid-trip
 * could sort in after the destination. Reported as: promoting a highlight
 * placed it after the destination on the map, with only a straight line (no
 * real route) to show for it — the backtracking a wrong order produces is
 * also exactly the kind of waypoint sequence that makes a Directions request
 * more likely to fail outright.
 *
 * Regions contributing no must-sees drop out entirely — the backbone is the
 * spine of things the trip is definitely built around, not one point per
 * region.
 */
export function buildIdealRouteBackbone(
  start: LatLng | undefined,
  regions: HighlightRegion[],
  end: LatLng | undefined,
): LatLng[] {
  const mustSees = regions.flatMap((region) =>
    region.candidateStops
      .filter(
        (stop): stop is LocatedStop =>
          stop.priority === 'must-see' && hasLocation(stop),
      )
      .map((stop) => ({ lat: stop.lat, lng: stop.lng })),
  )

  // A trip mid-edit can have a start/end point that hasn't been filled in
  // yet — ordering along a corridor needs both ends, so this just falls back
  // to listed order in that case (dropping the incomplete point, same as
  // before, rather than passing NaN coordinates through).
  const usableStart = isUsablePoint(start) ? start : undefined
  const usableEnd = isUsablePoint(end) ? end : undefined
  const orderedMustSees =
    usableStart && usableEnd
      ? [...mustSees].sort(
          (a, b) =>
            projectAlongRoute(usableStart, usableEnd, a) -
            projectAlongRoute(usableStart, usableEnd, b),
        )
      : mustSees

  return [usableStart, ...orderedMustSees, usableEnd].filter(isUsablePoint)
}

function isUsablePoint(point: LatLng | undefined): point is LatLng {
  return !!point && Number.isFinite(point.lat) && Number.isFinite(point.lng)
}

/**
 * Cheapest-insertion estimate of what visiting `candidate` costs on top of
 * the backbone: for each consecutive leg (A, B), how much longer A→candidate→B
 * is than A→B, minimised over all legs. That's the extra distance of slotting
 * the stop into wherever it fits best, which is what "detour" means to a
 * traveler looking at a shortlist.
 *
 * Straight-line (haversine) rather than real driving distance on purpose:
 * this runs client-side over every candidate on every priority change, and a
 * Directions call per candidate would be both slow and expensive for a figure
 * whose only job is to make candidates comparable to each other. It reads low
 * against real roads (especially around fjords and mountains) — an ordering
 * hint, not a routing promise.
 */
export function estimateDetourKm(
  candidate: LatLng,
  backbone: LatLng[],
): number {
  if (backbone.length < 2) return 0

  let cheapest = Infinity
  for (let i = 0; i < backbone.length - 1; i++) {
    const a = backbone[i]
    const b = backbone[i + 1]
    const viaCandidate =
      haversineDistanceKm(a, candidate) + haversineDistanceKm(candidate, b)
    const direct = haversineDistanceKm(a, b)
    const detour = viaCandidate - direct
    if (detour < cheapest) cheapest = detour
  }

  // Floating-point noise can push an exactly-on-the-line point microscopically
  // negative; a negative detour is meaningless either way.
  return Number.isFinite(cheapest) ? Math.max(0, cheapest) : 0
}

export type DetourEstimate =
  | { kind: 'on-route' }
  | { kind: 'unknown-location' }
  | { kind: 'detour'; km: number }

/**
 * What to show for one candidate. Must-sees define the backbone, so a
 * numeric detour for them would always be ~0 and read as false precision —
 * they're "on route" by construction. Candidates that never geocoded get no
 * figure at all rather than a misleading 0.
 */
export function describeDetour(
  stop: HighlightCandidateStop,
  backbone: LatLng[],
): DetourEstimate {
  if (stop.priority === 'must-see') return { kind: 'on-route' }
  if (!hasLocation(stop)) return { kind: 'unknown-location' }
  return {
    kind: 'detour',
    km: estimateDetourKm({ lat: stop.lat, lng: stop.lng }, backbone),
  }
}
