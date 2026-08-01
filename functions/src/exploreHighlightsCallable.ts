import { getFirestore } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/https'
import type { Trip } from '@rv/shared'
import { commitInChunks } from './firestoreBatch.js'
import { buildExploreCandidateWrites } from './exploreCandidates.js'
import { claudeApiKey, generateRegionHighlights } from './prompts/planTrip.js'

// If the function's container is killed by its own onCall timeout (or
// crashes outright) after claiming the lock but before the `finally` below
// runs, `planMeta.exploreStatus` is left stuck at 'generating' forever —
// every future click would fail immediately with "Already finding great
// stops" (see the transaction below). Comfortably above how long a genuine
// run should ever take (generateExploreHighlights' own timeoutSeconds), so
// this only ever kicks in for an actually-abandoned lock, not a slow one.
const STALE_EXPLORE_LOCK_MS = 5 * 60 * 1000

/**
 * Explore mode's own generation entry point (2026-07-30) — deliberately NOT
 * routed through the planRequests/generatePlan.ts pipeline the full/replan
 * flows use. That pipeline's whole shape (checkpointing, day-by-day Places/
 * Routes resolution, the busy guard on `planMeta.status`) exists for the
 * expensive three-phase generation; this only ever runs the first
 * (cheap, no per-day detail) phase, and must NOT touch `planMeta.status` —
 * that's what keeps the Map tab showing the explore screen instead of a
 * "generating" banner while this runs. Guarded by its own
 * `planMeta.exploreStatus` instead, so two devices on a shared trip can't
 * both trigger a redundant call at once.
 */
export async function generateExploreHighlightsForTrip(
  tripId: string,
): Promise<{ candidateCount: number }> {
  const db = getFirestore()
  const tripRef = db.collection('trips').doc(tripId)

  const claimed = await db.runTransaction(async (tx) => {
    const tripSnap = await tx.get(tripRef)
    if (!tripSnap.exists) {
      throw new HttpsError('not-found', 'Trip not found')
    }
    const meta = tripSnap.data()?.planMeta
    if (meta?.exploreStatus === 'generating') {
      const updatedAt = meta.exploreStatusUpdatedAt
        ? new Date(meta.exploreStatusUpdatedAt).getTime()
        : 0
      const isStale = Date.now() - updatedAt > STALE_EXPLORE_LOCK_MS
      if (!isStale) return false
    }
    tx.update(tripRef, {
      'planMeta.exploreStatus': 'generating',
      'planMeta.exploreStatusUpdatedAt': new Date().toISOString(),
    })
    return true
  })
  if (!claimed) {
    throw new HttpsError(
      'failed-precondition',
      'Already finding great stops for this trip — hang tight.',
    )
  }

  try {
    const tripSnap = await tripRef.get()
    const trip = tripSnap.data() as Trip

    const highlights = await generateRegionHighlights({
      settings: trip.settings,
      notesFreeText: trip.notes.freeText,
      tripId,
    })

    const existingCandidatesSnap = await tripRef
      .collection('corridorStops')
      .where('status', '==', 'candidate')
      .get()

    const writes = buildExploreCandidateWrites(
      tripRef,
      highlights,
      existingCandidatesSnap.docs.map((doc) => doc.ref),
    )
    await commitInChunks(db, writes)

    const candidateCount = writes.filter((w) => w.op === 'set').length
    return { candidateCount }
  } finally {
    await tripRef.update({ 'planMeta.exploreStatus': 'idle' })
  }
}

export const generateExploreHighlights = onCall(
  {
    secrets: [claudeApiKey],
    // Default 60s is too tight for a large multi-country trip: the
    // highlights call itself can retry once (MAX_ATTEMPTS in planTrip.ts),
    // and every candidate town is then geocoded before this returns. Well
    // under STALE_EXPLORE_LOCK_MS so a genuinely slow-but-alive run never
    // races the staleness check above.
    timeoutSeconds: 180,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be signed in')
    }
    const tripId = request.data?.tripId
    if (typeof tripId !== 'string') {
      throw new HttpsError('invalid-argument', 'tripId is required')
    }
    return generateExploreHighlightsForTrip(tripId)
  },
)
