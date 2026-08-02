import { doc, updateDoc } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import type { CorridorStopPriority } from '@rv/shared'
import { db, functions } from './firebase'
import type { CorridorStopWithId } from '../hooks/useCorridorStops'
import { LONG_CALLABLE_TIMEOUT_MS } from './callableTimeouts'

/** Highest-priority tier first — the order the explore list renders in. */
export const TIER_ORDER: CorridorStopPriority[] = [
  'must-see',
  'worth-a-detour',
  'nice-if-convenient',
]

/**
 * Promote/demote a candidate a WHOLE category (2026-08-02).
 *
 * A vote moves the stop straight into the tier above or below — "nice if
 * convenient" to "worth a detour" in one tap. It used to move one *position*
 * through the three tiers flattened into a single list, so a stop in the
 * middle of a five-stop tier needed five taps to change category at all, and
 * four of them looked like nothing had happened (the card shuffled a row
 * within the same heading). The category is the thing that carries meaning
 * downstream — it's what the route backbone reads and what the full
 * generation is seeded with — so that's what the arrows change.
 *
 * The trade-off, deliberately: there is no longer any way to reorder stops
 * *within* a category. Nothing reads that order except the list itself
 * (buildRouteBackbone sorts geographically along the corridor, and the
 * generation groups by tier), so it was costing taps without buying
 * anything.
 *
 * The stop lands adjacent to the boundary it crossed — promoting enters the
 * tier above at its BOTTOM edge, demoting the tier below at its TOP — so the
 * card moves the shortest visible distance, and promote+demote round-trips.
 * Rank is placed just past that edge (max+1 / min-1) rather than renumbering
 * the destination tier: only relative order matters, so one write beats
 * rewriting every sibling, and gaps/negatives sort fine.
 *
 * A plain client Firestore write, same as every other corridor-stop action
 * (src/lib/corridorStopActions.ts) — firestore.rules already allows any
 * member to write corridorStops.
 */
export async function voteExploreCandidate(
  tripId: string,
  grouped: Record<CorridorStopPriority, CorridorStopWithId[]>,
  stopId: string,
  direction: 'up' | 'down',
): Promise<void> {
  const tierIndex = TIER_ORDER.findIndex((tier) =>
    grouped[tier].some((candidate) => candidate.id === stopId),
  )
  if (tierIndex === -1) return

  const targetIndex = direction === 'up' ? tierIndex - 1 : tierIndex + 1
  // Already in the top or bottom category — nowhere left to go (the button
  // is disabled there).
  if (targetIndex < 0 || targetIndex >= TIER_ORDER.length) return

  const targetTier = TIER_ORDER[targetIndex]
  const targetRanks = grouped[targetTier].map((candidate) => candidate.rank ?? 0)
  const rank = targetRanks.length
    ? direction === 'up'
      ? Math.max(...targetRanks) + 1
      : Math.min(...targetRanks) - 1
    : 0

  await updateDoc(doc(db, 'trips', tripId, 'corridorStops', stopId), {
    priority: targetTier,
    rank,
  })
}

export function groupCandidatesByPriority(
  candidates: CorridorStopWithId[],
): Record<CorridorStopPriority, CorridorStopWithId[]> {
  const groups: Record<CorridorStopPriority, CorridorStopWithId[]> = {
    'must-see': [],
    'worth-a-detour': [],
    'nice-if-convenient': [],
  }
  for (const candidate of candidates) {
    const tier = candidate.priority ?? 'worth-a-detour'
    groups[tier].push(candidate)
  }
  for (const tier of Object.keys(groups) as CorridorStopPriority[]) {
    groups[tier].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
  }
  return groups
}

/** Triggers the cheap, repeatable highlights-only curation pass. */
export async function generateExploreHighlights(
  tripId: string,
): Promise<{ candidateCount: number }> {
  const call = httpsCallable<{ tripId: string }, { candidateCount: number }>(
    functions,
    'generateExploreHighlights',
    { timeout: LONG_CALLABLE_TIMEOUT_MS },
  )
  const result = await call({ tripId })
  return result.data
}
