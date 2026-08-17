import { getFirestore } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/https'
import type { CorridorStop, Trip } from '@rv/shared'
import { requireAccess } from './accessControl.js'
import { describeCause } from './describeCause.js'
import { requireTripMember } from './authz.js'
import {
  emptyPreferredCountries,
  type EmptyCountry,
} from './countryCoverage.js'
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

/**
 * How often a run in progress says it is still alive — see the heartbeat
 * below. Comfortably inside STALE_EXPLORE_LOCK_MS, so a living run can never
 * be mistaken for an abandoned one.
 */
const EXPLORE_HEARTBEAT_MS = 20_000


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
 *
 * Re-runnable without loss (2026-08-13): the result is merged into the
 * existing corridor rather than replacing it, so pressing this a second time
 * — weeks into curating, or by accident from Trip Setup's "Generate
 * overview" — costs a Claude call and adds whatever is new, and cannot cost
 * the traveler a single interest level they set. `candidateCount` is
 * therefore what was ADDED; `alreadyKnown` is how much of the answer they
 * already had.
 */
export async function generateExploreHighlightsForTrip(
  tripId: string,
): Promise<{
  candidateCount: number
  alreadyKnown: number
  emptyCountries: EmptyCountry[]
}> {
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

  // A real heartbeat, for the reason the rescan and day-detail paths both
  // needed one: exploreStatusUpdatedAt was written once, at the claim, and
  // then read as a liveness signal. A start timestamp cannot tell a slow run
  // from a container that died, so the lock could only ever be given a fixed
  // grace period and hope. Refreshed while alive, silence means over.
  const heartbeat = setInterval(() => {
    void tripRef
      .update({ 'planMeta.exploreStatusUpdatedAt': new Date().toISOString() })
      .catch((error: unknown) =>
        console.warn('Explore heartbeat write failed', error),
      )
  }, EXPLORE_HEARTBEAT_MS)

  try {
    const tripSnap = await tripRef.get()
    const trip = tripSnap.data() as Trip

    const highlights = await generateRegionHighlights({
      settings: trip.settings,
      notesFreeText: trip.notes.freeText,
      tripId,
    })

    // Every stop a refresh has to reckon with, including the `rejected`
    // ones: a suggestion the traveler already turned down must not come
    // back, which is the whole reason that status exists. `locked` stops
    // count as known too — a sight they have already committed to is
    // obviously not a new find.
    const existingSnap = await tripRef
      .collection('corridorStops')
      .where('status', 'in', ['candidate', 'locked', 'rejected'])
      .get()

    const merge = buildExploreCandidateWrites(
      tripRef,
      highlights,
      existingSnap.docs.map((doc) => doc.data() as CorridorStop),
    )
    // Claude proposing real sights but NONE of them being locatable means
    // every lookup failed — a systemic problem (missing/invalid Places key,
    // quota exhaustion, an outage), not the per-candidate best-effort
    // degradation buildExploreCandidateWrites' drop is meant for. Reported
    // as an error rather than an empty success: the traveler sees "nothing
    // found" for a route full of real stops, and the Claude call is already
    // paid for, so silently returning 0 is the worst possible outcome.
    // Deliberately checked before the write and before exploreLastRunAt, so
    // a broken run neither half-applies nor gets recorded as a genuine
    // "searched and found nothing".
    //
    // Measured against `unlocated` specifically, not against "nothing was
    // written" (2026-08-13). Now that a refresh merges, a run that proposes
    // ten sights the traveler already has writes nothing at all — and that
    // is a completely healthy result, not an outage.
    const proposedCount = highlights.regions.reduce(
      (total, region) => total + region.candidateStops.length,
      0,
    )
    if (proposedCount > 0 && merge.unlocated === proposedCount) {
      throw new HttpsError(
        'internal',
        `Found ${proposedCount} stops but could not locate any of them on the map — please try again.`,
      )
    }

    await commitInChunks(db, merge.writes)

    // A completed run only — not attempted-but-failed — so the frontend
    // can tell "never searched" apart from "searched and genuinely found
    // nothing" regardless of which screen fired the call. See
    // planMeta.exploreLastRunAt's own doc comment in shared/src/schemas.ts.
    await tripRef.update({ 'planMeta.exploreLastRunAt': new Date().toISOString() })
    // Which chosen countries came back with nothing, and why. Without this a
    // country the traveler explicitly picked can vanish from the answer with
    // no explanation anywhere — see countryCoverage.ts.
    const emptyCountries = emptyPreferredCountries(
      trip.settings.preferredCountries,
      highlights,
    )
    if (emptyCountries.length > 0) {
      console.info(
        `Preferred countries with nothing on the map for trip ${tripId}: ${emptyCountries
          .map((entry) => `${entry.country} (${entry.reason})`)
          .join(', ')}`,
      )
    }
    return {
      candidateCount: merge.added,
      alreadyKnown: merge.alreadyKnown,
      emptyCountries,
    }
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
    clearInterval(heartbeat)
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
