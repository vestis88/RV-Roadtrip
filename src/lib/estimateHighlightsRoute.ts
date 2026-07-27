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
 * The "ideal route" the review panel measures detours against: start, every
 * must-see candidate that has coordinates, then finish.
 *
 * Order is the order the highlights phase already produced — region order,
 * then within-region array order — deliberately NOT re-sorted geographically.
 * HIGHLIGHTS_SYSTEM_PROMPT's step 1 works out the geographic corridor from
 * startPoint to endPoint before listing anything, so its own ordering is
 * already roughly along that corridor; re-sorting here would just substitute
 * a naive nearest-neighbour guess for the model's corridor reasoning.
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
  // yet; dropping the incomplete end rather than passing NaN coordinates
  // through keeps every downstream distance real.
  return [start, ...mustSees, end].filter(isUsablePoint)
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
