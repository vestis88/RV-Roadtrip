import { doc, writeBatch } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import type { CorridorStopPriority } from '@rv/shared'
import { db, functions } from './firebase'
import type { CorridorStopWithId } from '../hooks/useCorridorStops'

/**
 * Up/down voting (bringing back the old highlights-review panel's
 * re-ranked-priority-tiers behavior, 2026-07-30): tiers are ranked
 * independently, so a vote only ever swaps `rank` with the immediate
 * neighbor sharing the same `priority` — moving 'A' up past a
 * higher-priority tier isn't "voting", that's what locking/promoting a
 * stop into consideration is for. A plain client Firestore write, same as
 * every other corridor-stop action (src/lib/corridorStopActions.ts) —
 * firestore.rules already allows any member to write corridorStops.
 */
export async function voteExploreCandidate(
  tripId: string,
  candidatesInTier: CorridorStopWithId[],
  stopId: string,
  direction: 'up' | 'down',
): Promise<void> {
  const sorted = [...candidatesInTier].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
  const index = sorted.findIndex((c) => c.id === stopId)
  if (index === -1) return
  const swapWithIndex = direction === 'up' ? index - 1 : index + 1
  if (swapWithIndex < 0 || swapWithIndex >= sorted.length) return

  const a = sorted[index]
  const b = sorted[swapWithIndex]
  const batch = writeBatch(db)
  batch.update(doc(db, 'trips', tripId, 'corridorStops', a.id), { rank: b.rank ?? 0 })
  batch.update(doc(db, 'trips', tripId, 'corridorStops', b.id), { rank: a.rank ?? 0 })
  await batch.commit()
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
