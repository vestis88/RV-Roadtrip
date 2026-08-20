import type { DocumentReference } from 'firebase-admin/firestore'
import {
  corridorStopSchema,
  type CorridorStop,
  type CorridorStopPriority,
  type CorridorStopStatus,
  type SightTimeNeeded,
} from '@rv/shared'
import type { PendingWrite } from './firestoreBatch.js'
import type {
  RegionHighlightCandidate,
  RegionHighlightsResponse,
} from './prompts/planTripSchema.js'

/**
 * A corridor stop already in Firestore, as much of it as the merge below
 * needs: its name (identity), and its tier (so new finds rank after it). No
 * ref, because nothing here deletes anything any more.
 */
export type ExistingCandidateStop = Pick<CorridorStop, 'name' | 'priority'>

export interface ExploreCandidateMerge {
  writes: PendingWrite[]
  /** Genuinely new suggestions, written as fresh `candidate` stops. */
  added: number
  /** Suggestions already in the corridor — left exactly as the traveler left them. */
  alreadyKnown: number
  /** Suggestions whose sight could not be located, and so were not written at all. */
  unlocated: number
}

/**
 * Collapses a place name to a comparison key: case-folded, diacritics
 * dropped, punctuation and spacing removed. "Møns Klint", "Mons Klint" and
 * "møns klint" are one place.
 */
function identityKey(name: string): string {
  return name
    .toLowerCase()
    // Letters NFD does not decompose, for the same reason placesApi.ts's
    // nameTokens special-cases them: they are letters, not a base plus an
    // accent, so the strip below would delete them outright.
    .replace(/\u00f8/g, 'o')
    .replace(/\u00e6/g, 'ae')
    .replace(/\u00df/g, 'ss')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '')
}

/**
 * Explore mode (2026-07-30): flattens a highlights-only curation pass into
 * `candidate` corridorStop writes — one doc per curated sight, region label
 * preserved for the explore list's grouping, `rank` assigned by position
 * within its own priority tier (Claude already orders each region's
 * candidateStops by how strongly it favors them, and regions themselves come
 * out in roughly-corridor order, so walking the response top-to-bottom and
 * incrementing per tier as candidates are encountered reproduces that
 * ordering without re-deriving it).
 *
 * MERGES with what is already there (2026-08-13). It used to delete every
 * existing `candidate` stop first, on the reasoning that a fresh pass
 * reflects the trip's current settings and stale candidates shouldn't linger
 * beside new ones. That was defensible while candidates were consumed at
 * generation and gone; it stopped being defensible the day generation began
 * preserving them. A traveler may now spend weeks setting interest levels,
 * keeping some stops and turning others down — and pressing "Find more
 * stops" threw all of it away and handed back a fresh list, including every
 * suggestion they had already rejected.
 *
 * So: existing stops are never touched, a proposal matching one by name is
 * counted and skipped, and only genuinely new finds are written. Matching is
 * by name alone, deliberately NOT by proximity the way writeGeneratedDays
 * dedupes overnight towns — sights cluster, and a 5 km proximity rule would
 * decide that Kronborg Castle and the Maritime Museum next door are the same
 * suggestion. Name matching is reliable here because the sight's name comes
 * back from Places itself rather than from the model (see
 * verifyPlaceLocation), so the same sight resolves to the same string across
 * passes however Claude spelled it this time.
 *
 * `rejected` stops are passed in alongside the live ones and match the same
 * way: that status exists precisely so a refresh can tell "never suggested"
 * from "suggested and turned down" (see corridorStopStatusSchema).
 */
export function buildExploreCandidateWrites(
  tripRef: DocumentReference,
  highlights: RegionHighlightsResponse,
  existing: ExistingCandidateStop[],
): ExploreCandidateMerge {
  const writes: PendingWrite[] = []
  const knownKeys = new Set(existing.map((stop) => identityKey(stop.name)))

  // New finds are appended after whatever is already in their tier, so a
  // refresh never reshuffles the list the traveler has been working through.
  const nextRankByPriority = new Map<CorridorStopPriority, number>()
  for (const stop of existing) {
    const priority = stop.priority ?? 'worth-a-detour'
    nextRankByPriority.set(priority, (nextRankByPriority.get(priority) ?? 0) + 1)
  }

  let added = 0
  let alreadyKnown = 0
  let unlocated = 0
  for (const region of highlights.regions) {
    for (const candidate of region.candidateStops) {
      if (candidate.lat === undefined || candidate.lng === undefined) {
        // Best-effort sight resolution (see geocodeHighlights) — a candidate
        // whose sight could not be verified where it was said to be has
        // nothing to put a map marker at, and a guessed marker is how a
        // Danish dinner stop ended up in Greece. Dropped rather than written
        // at an approximate location.
        unlocated++
        continue
      }
      const key = identityKey(candidate.sight)
      if (knownKeys.has(key)) {
        alreadyKnown++
        continue
      }
      // Guards against one pass proposing the same sight from two regions,
      // which would otherwise write it twice in a single batch.
      knownKeys.add(key)
      const rank = nextRankByPriority.get(candidate.priority) ?? 0
      nextRankByPriority.set(candidate.priority, rank + 1)
      added++
      writes.push({
        op: 'set',
        ref: tripRef.collection('corridorStops').doc(),
        data: corridorStopSchema.parse({
          name: candidate.sight,
          lat: candidate.lat,
          lng: candidate.lng,
          country: candidate.country,
          why: candidate.why,
          status: 'candidate',
          // Research: a Claude call paid for it. See corridorStopSchema.origin.
          origin: 'traveler',
          linkedDayIds: [],
          priority: candidate.priority,
          region: region.region,
          rank,
          baseTown: candidate.town,
          ...(candidate.interest ? { interest: candidate.interest } : {}),
          ...(candidate.timeNeeded ? { timeNeeded: candidate.timeNeeded } : {}),
          ...(candidate.googleMapsUrl
            ? { googleMapsUrl: candidate.googleMapsUrl }
            : {}),
          ...(candidate.photoUrl ? { photoUrl: candidate.photoUrl } : {}),
        }),
      })
    }
  }
  return { writes, added, alreadyKnown, unlocated }
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
  baseTown?: string
  photoUrl?: string
  interest?: string
  timeNeeded?: SightTimeNeeded
  status?: CorridorStopStatus
  routeIndex?: number
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
 * A stop's own name is its `sight` and `baseTown` is where to sleep while
 * seeing it. A stop with no `baseTown` — one curated before sights led the
 * route, a hand-dropped pin, a rescan find — is a place whose own name is
 * the whole story, so it stands as both: that is what it always meant, and
 * inventing a separate base town for it would be a guess the outline phase
 * would then route around. `interest`/`timeNeeded` are passed through only
 * when the stop actually has them; the outline prompt is told what to assume
 * when they're missing, rather than being handed a default that reads as a
 * measurement.
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
      sight: stop.name,
      town: stop.baseTown ?? stop.name,
      country: stop.country,
      why: stop.why ?? `${stop.name}, chosen while exploring the route.`,
      priority: stop.priority ?? 'worth-a-detour',
      ...(stop.interest ? { interest: stop.interest } : {}),
      ...(stop.timeNeeded ? { timeNeeded: stop.timeNeeded } : {}),
      lat: stop.lat,
      lng: stop.lng,
      ...(stop.photoUrl ? { photoUrl: stop.photoUrl } : {}),
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

/**
 * The locked stops' names in driving order — what the route phase is told it
 * must follow.
 *
 * Ordered by `routeIndex`, which the explore map writes from Google's own
 * answer (see corridorStopSchema.routeIndex). A stop with no routeIndex
 * sorts last rather than to the front: it has simply never been drawn on a
 * route, and guessing zero for it would put it first and invent exactly the
 * kind of order this exists to stop being invented.
 */
export function lockedRouteOrder(candidates: CandidateLike[]): string[] {
  return candidates
    .filter((stop) => stop.status === 'locked')
    .sort(
      (a, b) =>
        (a.routeIndex ?? Number.MAX_SAFE_INTEGER) -
        (b.routeIndex ?? Number.MAX_SAFE_INTEGER),
    )
    .map((stop) => stop.name)
}
