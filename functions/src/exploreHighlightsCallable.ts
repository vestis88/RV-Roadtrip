import { getFirestore } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/https'
import type { Trip } from '@rv/shared'
import { requireAccess } from './accessControl.js'
import { requireTripMember } from './authz.js'
import { commitInChunks } from './firestoreBatch.js'
import { buildExploreCandidateWrites } from './exploreCandidates.js'
import { googlePlacesApiKey } from './placesApi.js'
import { claudeApiKey, generateRegionHighlights } from './prompts/planTrip.js'

// If the function's container is killed by its own onCall timeout (or
// crashes outright) after claiming the lock but before the `finally` below
// runs, `planMeta.exploreStatus` is left stuck at 'generating' forever —
// every future click would fail immediately with "Already finding great
// stops" (see the transaction below). Comfortably above how long a genuine
// run should ever take (generateExploreHighlights' own timeoutSeconds), so
// this only ever kicks in for an actually-abandoned lock, not a slow one.
const STALE_EXPLORE_LOCK_MS = 5 * 60 * 1000

// Long enough to name the fault, short enough to read on a phone. The
// underlying messages are not sized for a UI at all — a Claude parse
// failure carries a 300-character excerpt of the raw response — and the
// full text is in the logs either way.
const CAUSE_PREVIEW_LENGTH = 160

function describeCause(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const collapsed = message.replace(/\s+/g, ' ').trim()
  return collapsed.length > CAUSE_PREVIEW_LENGTH
    ? `${collapsed.slice(0, CAUSE_PREVIEW_LENGTH)}…`
    : collapsed
}

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
    const candidateCount = writes.filter((w) => w.op === 'set').length
    // Claude proposing real towns but NONE of them surviving to a write
    // means every geocode failed — a systemic problem (missing/invalid
    // Places key, quota exhaustion, an outage), not the per-candidate
    // best-effort degradation buildExploreCandidateWrites' drop is meant
    // for. Reported as an error rather than an empty success: the traveler
    // sees "nothing found" for a route full of real stops, and the Claude
    // call is already paid for, so silently returning 0 is the worst
    // possible outcome. Deliberately checked before the write and before
    // exploreLastRunAt, so a broken run neither half-applies nor gets
    // recorded as a genuine "searched and found nothing".
    const proposedCount = highlights.regions.reduce(
      (total, region) => total + region.candidateStops.length,
      0,
    )
    if (proposedCount > 0 && candidateCount === 0) {
      throw new HttpsError(
        'internal',
        `Found ${proposedCount} stops but could not locate any of them on the map — please try again.`,
      )
    }

    await commitInChunks(db, writes)

    // A completed run only — not attempted-but-failed — so the frontend
    // can tell "never searched" apart from "searched and genuinely found
    // nothing" regardless of which screen fired the call. See
    // planMeta.exploreLastRunAt's own doc comment in shared/src/schemas.ts.
    await tripRef.update({ 'planMeta.exploreLastRunAt': new Date().toISOString() })
    return { candidateCount }
  } catch (error) {
    // firebase-functions only forwards the message of an HttpsError;
    // anything else reaches the browser as the bare code 'internal' with the
    // message "INTERNAL". That is how the 2026-08-12 failure was reported:
    // Claude returned unparseable JSON twice, the run threw a plain Error,
    // and the traveler was told "please try again" — advice that cannot
    // work for a deterministic fault and costs two more Claude calls each
    // time it is followed. Re-thrown with the cause attached so the screen
    // can say what actually broke; the full error still goes to the logs,
    // which the truncated preview is no substitute for.
    if (error instanceof HttpsError) throw error
    console.error(`generateExploreHighlights failed for trip ${tripId}`, error)
    throw new HttpsError(
      'internal',
      `Could not find stops: ${describeCause(error)}`,
    )
  } finally {
    await tripRef.update({ 'planMeta.exploreStatus': 'idle' })
  }
}

export const generateExploreHighlights = onCall(
  {
    // GOOGLE_PLACES_API_KEY is needed even though nothing here calls Places
    // directly: generateRegionHighlights geocodes every candidate town
    // (geocodeHighlights -> geocodeQuery) before returning. A Functions v2
    // secret is only readable by a function that declares it, so omitting it
    // made geocodeQuery throw for EVERY candidate — each one caught by
    // geocodeHighlights' per-candidate best-effort handler, left without
    // coordinates, and then silently dropped by buildExploreCandidateWrites.
    // The run "succeeded" with zero stops after paying full Claude cost.
    secrets: [claudeApiKey, googlePlacesApiKey],
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
    requireAccess(request.auth)
    const tripId = request.data?.tripId
    if (typeof tripId !== 'string') {
      throw new HttpsError('invalid-argument', 'tripId is required')
    }
    await requireTripMember(tripId, request.auth.uid)
    return generateExploreHighlightsForTrip(tripId)
  },
)
