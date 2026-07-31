import { getFirestore } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/https'
import type { Trip } from '@rv/shared'
import { commitInChunks } from './firestoreBatch.js'
import { buildExploreCandidateWrites } from './exploreCandidates.js'
import { claudeApiKey, generateRegionHighlights } from './prompts/planTrip.js'

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
    if (tripSnap.data()?.planMeta?.exploreStatus === 'generating') {
      return false
    }
    tx.update(tripRef, { 'planMeta.exploreStatus': 'generating' })
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
  { secrets: [claudeApiKey] },
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
