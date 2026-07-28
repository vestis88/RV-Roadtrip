import { buildRouteBackbone, estimateDetourKm, type LatLng } from '@rv/shared'

export { estimateDetourKm }

export type HighlightPriority =
  'must-see' | 'worth-a-detour' | 'nice-if-convenient'

/**
 * Where a candidate came from. Absent/undefined means the original curated
 * highlights pass — the field only exists so the opt-in web-search
 * enrichment step's finds can be labelled as such in the review panel, and
 * every candidate written before that feature existed stays valid without it.
 */
export type HighlightSource = 'curated' | 'search'

export interface HighlightCandidateStop {
  town: string
  country: string
  why: string
  priority: HighlightPriority
  source?: HighlightSource
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
 * The "ideal route" the review panel measures detours against (and draws):
 * start, every must-see candidate that has coordinates — sorted by how far
 * along the start→end corridor each one sits — then finish.
 *
 * Regions contributing no must-sees drop out entirely — the backbone is the
 * spine of things the trip is definitely built around, not one point per
 * region.
 *
 * Only the extract-must-sees-from-regions part lives here; the geometry
 * itself is @rv/shared's buildRouteBackbone, shared with the backend's
 * highlights web-search enrichment (which builds the same backbone from its
 * own region types to bound how far off-route a find may be). The corridor
 * sort in particular has already been got wrong once — a single
 * implementation is what stops it being got wrong differently in two places.
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

  return buildRouteBackbone(start, mustSees, end)
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
