import type { DocumentReference } from 'firebase-admin/firestore'
import { corridorStopSchema, type CorridorStopPriority } from '@rv/shared'
import type { PendingWrite } from './firestoreBatch.js'
import type {
  RegionHighlightCandidate,
  RegionHighlightsResponse,
} from './prompts/planTripSchema.js'

/**
 * Explore mode (2026-07-30): flattens a fresh highlights-only curation pass
 * into `candidate` corridorStop writes — one doc per candidate town, region
 * label preserved for the explore list's grouping, `rank` assigned by
 * position within its own priority tier (Claude already orders each
 * region's candidateStops by how strongly it favors them, and regions
 * themselves come out in roughly-corridor order, so walking the response
 * top-to-bottom and incrementing per tier as candidates are encountered
 * reproduces that ordering without re-deriving it).
 *
 * Deletes every EXISTING `candidate` stop first (passed in by the caller,
 * already read) — a fresh curation pass reflects the trip's current
 * settings, so stale candidates from before a settings change shouldn't
 * linger alongside new ones. `locked` stops (the traveler's explicit
 * approvals) are never touched here — that's the caller's job to preserve.
 */
export function buildExploreCandidateWrites(
  tripRef: DocumentReference,
  highlights: RegionHighlightsResponse,
  existingCandidateRefs: DocumentReference[],
): PendingWrite[] {
  const writes: PendingWrite[] = existingCandidateRefs.map((ref) => ({
    op: 'delete',
    ref,
  }))

  const nextRankByPriority = new Map<CorridorStopPriority, number>()
  for (const region of highlights.regions) {
    for (const candidate of region.candidateStops) {
      if (candidate.lat === undefined || candidate.lng === undefined) {
        // Best-effort geocoding (see generateRegionHighlights) — a candidate
        // that never resolved has nothing to put a map marker at, so it's
        // dropped here rather than written with unusable coordinates.
        continue
      }
      const rank = nextRankByPriority.get(candidate.priority) ?? 0
      nextRankByPriority.set(candidate.priority, rank + 1)
      writes.push({
        op: 'set',
        ref: tripRef.collection('corridorStops').doc(),
        data: corridorStopSchema.parse({
          name: candidate.town,
          lat: candidate.lat,
          lng: candidate.lng,
          country: candidate.country,
          why: candidate.why,
          status: 'candidate',
          linkedDayIds: [],
          priority: candidate.priority,
          region: region.region,
          rank,
        }),
      })
    }
  }
  return writes
}

interface CandidateLike {
  name: string
  lat: number
  lng: number
  country?: string
  why?: string
  priority?: CorridorStopPriority
  region?: string
  rank?: number
}

/**
 * The reverse direction, used when explore mode is committed to a full plan:
 * regroups every surviving `candidate`/`locked` stop back into the shape
 * generateSkeletonFromHighlights expects, so the real (expensive) generation
 * seeds from exactly what the traveler curated instead of re-running the
 * highlights phase from scratch. Grouped by `region` where one was recorded
 * (every explore-curated candidate has one); anything without a region — a
 * rescan find or a manually pinned stop, neither of which has region
 * context — falls into one "Added stops" catch-all region per country
 * rather than being dropped.
 *
 * A stop with no `country` (a hand-placed pin dropped before Places
 * resolved one) can't become a RegionHighlightCandidate, which requires a
 * 2-letter country — skipped rather than failing the whole commit, same
 * "degrade one item, not the whole batch" pattern this app already uses for
 * unresolved geocoding elsewhere.
 */
export function buildRegionHighlightsFromCandidates(
  candidates: CandidateLike[],
): RegionHighlightsResponse {
  const byRegionKey = new Map<
    string,
    { region: string; country: string; items: RegionHighlightCandidate[] }
  >()

  const sorted = [...candidates].sort((a, b) => {
    const tierOrder = { 'must-see': 0, 'worth-a-detour': 1, 'nice-if-convenient': 2 }
    const aTier = tierOrder[a.priority ?? 'worth-a-detour']
    const bTier = tierOrder[b.priority ?? 'worth-a-detour']
    if (aTier !== bTier) return aTier - bTier
    return (a.rank ?? 0) - (b.rank ?? 0)
  })

  for (const stop of sorted) {
    if (!stop.country) continue
    const regionLabel = stop.region ?? `Added stops (${stop.country})`
    const key = `${regionLabel}|${stop.country}`
    let group = byRegionKey.get(key)
    if (!group) {
      group = { region: regionLabel, country: stop.country, items: [] }
      byRegionKey.set(key, group)
    }
    group.items.push({
      town: stop.name,
      country: stop.country,
      why: stop.why ?? `${stop.name}, chosen while exploring the route.`,
      priority: stop.priority ?? 'worth-a-detour',
      lat: stop.lat,
      lng: stop.lng,
    })
  }

  return {
    regions: [...byRegionKey.values()].map((group) => ({
      region: group.region,
      country: group.country,
      reasoning: 'Selected by the traveler while exploring the route.',
      candidateStops: group.items,
    })),
  }
}
