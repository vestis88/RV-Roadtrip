import { doc, updateDoc, writeBatch } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import type { CorridorStopPriority } from '@rv/shared'
import { db, functions } from './firebase'
import type { CorridorStopWithId } from '../hooks/useCorridorStops'

/** Highest-priority tier first — the order the explore list renders in. */
export const TIER_ORDER: CorridorStopPriority[] = [
  'must-see',
  'worth-a-detour',
  'nice-if-convenient',
]

/**
 * Promote/demote a candidate (2026-08-01: extended to cross tiers).
 *
 * The three tiers behave as ONE flat ordered list rather than three sealed
 * ones: a vote moves the stop exactly one position, and if that position is
 * across a tier boundary the stop changes `priority` to match where it
 * landed. Originally a vote could only swap `rank` within its own tier,
 * which left the top and bottom stop of every tier with both buttons dead —
 * reported as "the promote/demote does not seem to work", since the tiers
 * Claude produces are often small enough that many stops sit on a boundary,
 * and there was no way at all to move a stop between tiers.
 *
 * Crossing keeps the stop adjacent to where it came from: promoting enters
 * the tier above at its BOTTOM edge, demoting enters the tier below at its
 * TOP edge. Rank is placed just past that edge (max+1 / min-1) rather than
 * renumbering the destination tier — only ordering matters, so one write
 * beats rewriting every sibling, and gaps/negatives sort fine.
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

  // groupCandidatesByPriority already rank-sorts each tier.
  const inTier = grouped[TIER_ORDER[tierIndex]]
  const index = inTier.findIndex((candidate) => candidate.id === stopId)
  const swapWithIndex = direction === 'up' ? index - 1 : index + 1

  if (swapWithIndex >= 0 && swapWithIndex < inTier.length) {
    const a = inTier[index]
    const b = inTier[swapWithIndex]
    const batch = writeBatch(db)
    batch.update(doc(db, 'trips', tripId, 'corridorStops', a.id), { rank: b.rank ?? 0 })
    batch.update(doc(db, 'trips', tripId, 'corridorStops', b.id), { rank: a.rank ?? 0 })
    await batch.commit()
    return
  }

  const targetIndex = direction === 'up' ? tierIndex - 1 : tierIndex + 1
  // Already at the very top of 'must-see' or the very bottom of
  // 'nice-if-convenient' — nowhere left to go (the button is disabled there).
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
  )
  const result = await call({ tripId })
  return result.data
}
