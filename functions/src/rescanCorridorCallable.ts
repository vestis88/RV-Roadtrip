import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/https'
import { corridorStopSchema, type LatLng, type Trip } from '@rv/shared'
import { requireAccess } from './accessControl.js'
import { describeCause } from './describeCause.js'
import { requireTripMember } from './authz.js'
import { googlePlacesApiKey } from './placesApi.js'
import {
  MAX_RESCAN_RADIUS_KM,
  claudeApiKey,
  droppedForDistance,
  generateRescanCandidates,
  notLocated,
} from './prompts/rescanCorridor.js'
import { findStopsForQuery } from './querySearch.js'

/**
 * How long the search itself may run, leaving the rest of the function's
 * 300s for geocoding every find and committing the writes.
 *
 * The deadline is stated here, by the caller that owns the timeout, rather
 * than inferred inside the search — which is what let the search run until
 * the container was killed and everything it had found was thrown away.
 * Reported as "Scanning… 5m 4s" and then an error, which is this function's
 * own ceiling to the second.
 */
const SEARCH_BUDGET_MS = 220_000

/**
 * How often a running scan says it is still alive.
 *
 * `rescanStatusUpdatedAt` was written once, at the start, and described as a
 * heartbeat — which it wasn't. A single timestamp cannot distinguish a scan
 * that is two minutes into a slow web search from one whose container was
 * killed two minutes ago, so the only safe reading was "assume alive", and
 * the button sat disabled behind a counter that climbed past anything the
 * server could still be doing. Refreshing it on a timer makes the claim
 * mean what its name says: gone quiet for more than a couple of intervals
 * and the run is over, however it ended.
 */
const RESCAN_HEARTBEAT_MS = 20_000

/**
 * "Rescan this area" (phase 3 of the persistent-corridor overhaul): searches
 * near `center` and writes each surviving find as a new corridorStops doc,
 * unlinked to any day — reviewing/locking/discarding a proposed stop is a
 * plain client-side Firestore write (see src/lib/corridorStopActions.ts),
 * same as markSelected. This never touches `committed`/`locked` stops or the
 * days collection, so it needs none of generatePlan.ts/replanTrip.ts's
 * busy-guard machinery — concurrent rescans are merely redundant, not
 * corrupting.
 *
 * Explore mode (2026-07-30): a rescan run before any plan exists
 * (`planMeta.status === 'idle'`) writes `candidate` instead of `proposed` —
 * same review-then-decide meaning, but grouped with the rest of explore
 * mode's finds rather than the post-generation corridor-editing surface a
 * `proposed` stop implies. Appended to the end of the `worth-a-detour` tier
 * (a rescan find has no region-level priority reasoning behind it the way a
 * curated candidate does, so it isn't assumed must-see) — ranked after
 * whatever's already there so it doesn't jump ahead of curated candidates
 * the traveler hasn't reacted to yet.
 */
export async function runRescanCorridor(
  tripId: string,
  center: LatLng,
  radiusKm: number,
  // A traveler-typed description of what they're looking for, from
  // AddCorridorStopForm's "Describe what you want" mode — see
  // rescanCorridorPrompt.ts's own doc comment. Optional: omitted, this is
  // the plain "Rescan this area" behavior, unchanged.
  query?: string,
  // The explore-mode route corridor — see generateRescanCandidates' own doc
  // comment. Optional: omitted, filtering stays distance-from-center as
  // before.
  backbone?: LatLng[],
  // Names for the same geography — see buildRescanCorridorPrompt's own doc
  // comment for why sending coordinates alone was so expensive.
  centerName?: string,
  waypointNames?: string[],
  deadlineMs?: number,
): Promise<{ stopsWritten: number; droppedTooFar: number; notLocated: number }> {
  const db = getFirestore()
  const tripRef = db.collection('trips').doc(tripId)
  const tripSnap = await tripRef.get()
  if (!tripSnap.exists) {
    throw new HttpsError('not-found', 'Trip not found')
  }
  const trip = tripSnap.data() as Trip
  const isExploring = trip.planMeta.status === 'idle'

  // A typed query goes to Places first (see findStopsForQuery); the plain
  // "Rescan this area" pass has no query to search for and is Claude's job
  // by definition — "what's worth stopping for around here" is a judgement,
  // not a lookup.
  const finds = query
    ? (
        await findStopsForQuery({
          query,
          center,
          radiusKm,
          notesFreeText: trip.notes.freeText,
          interests: trip.settings.interests,
          tripId,
          backbone,
          centerName,
          waypointNames,
        })
      ).finds
    : await generateRescanCandidates({
        center,
        radiusKm,
        notesFreeText: trip.notes.freeText,
        // The trip's own stated interests. Their absence here is why a
        // rescan for a downhill-biking trip answered "nothing nearby" with
        // a bike park inside the circle — see buildRescanCorridorPrompt.
        interests: trip.settings.interests,
        tripId,
        backbone,
        centerName,
        waypointNames,
          ...(deadlineMs !== undefined ? { deadlineMs } : {}),
  })

  let nextRank = 0
  if (isExploring && finds.length > 0) {
    const existingTierSnap = await tripRef
      .collection('corridorStops')
      .where('status', '==', 'candidate')
      .where('priority', '==', 'worth-a-detour')
      .get()
    nextRank = existingTierSnap.size
  }

  await Promise.all(
    finds.map((find, i) =>
      tripRef.collection('corridorStops').add(
        corridorStopSchema.parse({
          name: find.name,
          lat: find.lat,
          lng: find.lng,
          country: find.country,
          why: find.why,
          status: isExploring ? 'candidate' : 'proposed',
          linkedDayIds: [],
          ...(isExploring
            ? { priority: 'worth-a-detour' as const, rank: nextRank + i }
            : {}),
        }),
      ),
    ),
  )

  return {
    stopsWritten: finds.length,
    droppedTooFar: droppedForDistance(finds),
    notLocated: notLocated(finds),
  }
}

export const rescanCorridor = onCall(
  {
    secrets: [claudeApiKey, googlePlacesApiKey],
    // Raised from 180 when this call still ran up to three web searches per
    // turn. The search is gone (see rescanCorridor.ts's own note) and a
    // tool-free turn plus geocoding is a fraction of that, so this is now
    // pure headroom rather than a limit anything approaches. Left high on
    // purpose: unlike the overnight picker there is no partial result to
    // degrade to, so the deadline firing still costs the traveler the whole
    // search, and nothing is paid for headroom that goes unused.
    timeoutSeconds: 300,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be signed in')
    }
    requireAccess(request.auth)
    const tripId = request.data?.tripId
    const center = request.data?.center as LatLng | undefined
    const radiusKm = request.data?.radiusKm
    const query = request.data?.query
    const backbone = request.data?.backbone as LatLng[] | undefined
    const centerName = request.data?.centerName
    const waypointNames = request.data?.waypointNames
    if (
      typeof tripId !== 'string' ||
      typeof center?.lat !== 'number' ||
      typeof center?.lng !== 'number' ||
      typeof radiusKm !== 'number' ||
      (query !== undefined && typeof query !== 'string') ||
      (backbone !== undefined &&
        (!Array.isArray(backbone) ||
          backbone.some((p) => typeof p?.lat !== 'number' || typeof p?.lng !== 'number'))) ||
      (centerName !== undefined && typeof centerName !== 'string') ||
      (waypointNames !== undefined &&
        (!Array.isArray(waypointNames) ||
          waypointNames.some((name) => typeof name !== 'string')))
    ) {
      throw new HttpsError(
        'invalid-argument',
        'tripId, center {lat,lng}, and radiusKm are required; query and centerName, if given, must be strings; backbone, if given, must be an array of {lat,lng}; waypointNames, if given, must be an array of strings',
      )
    }
    if (radiusKm <= 0 || radiusKm > MAX_RESCAN_RADIUS_KM) {
      throw new HttpsError(
        'invalid-argument',
        `radiusKm must be between 0 and ${MAX_RESCAN_RADIUS_KM}`,
      )
    }
    if (query !== undefined && query.trim().length > 200) {
      throw new HttpsError('invalid-argument', 'query must be 200 characters or fewer')
    }
    if (backbone !== undefined && backbone.length > 50) {
      throw new HttpsError('invalid-argument', 'backbone must be 50 points or fewer')
    }
    // These go straight into the prompt, so they're bounded like `query` is.
    if (centerName !== undefined && centerName.length > 200) {
      throw new HttpsError('invalid-argument', 'centerName must be 200 characters or fewer')
    }
    if (
      waypointNames !== undefined &&
      (waypointNames.length > 50 ||
        waypointNames.some((name: string) => name.length > 200))
    ) {
      throw new HttpsError(
        'invalid-argument',
        'waypointNames must be 50 names or fewer, each 200 characters or fewer',
      )
    }
    await requireTripMember(tripId, request.auth.uid)

    // Progress lives on the trip from here on, not in the caller's promise.
    // The client hanging up does not cancel this function (see
    // callableTimeouts.ts), and on a phone hanging up is routine: switching
    // tabs unmounts the button, and backgrounding the app can drop the
    // connection outright. Either way the search runs to completion and
    // writes its stops — what the traveler lost was any way to know that.
    // Writing status here means the answer is waiting for them when they
    // come back, whether or not the connection that started it survived.
    const tripRef = getFirestore().collection('trips').doc(tripId)
    await tripRef.update({
      'planMeta.rescanStatus': 'generating',
      'planMeta.rescanStatusUpdatedAt': new Date().toISOString(),
      'planMeta.rescanStartedAt': new Date().toISOString(),
    })
    // Keeps saying so for as long as this container is alive — see
    // RESCAN_HEARTBEAT_MS. Failures here are deliberately swallowed: a
    // missed beat is worth far less than the search it would abort.
    const heartbeat = setInterval(() => {
      void tripRef
        .update({ 'planMeta.rescanStatusUpdatedAt': new Date().toISOString() })
        .catch((error: unknown) =>
          console.warn('Rescan heartbeat write failed', error),
        )
    }, RESCAN_HEARTBEAT_MS)
    try {
      const { stopsWritten, droppedTooFar, notLocated: unlocatable } = await runRescanCorridor(
        tripId,
        center,
        radiusKm,
        query?.trim() || undefined,
        backbone,
        (centerName as string | undefined)?.trim() || undefined,
        waypointNames as string[] | undefined,
        Date.now() + SEARCH_BUDGET_MS,
      )
      await tripRef.update({
        'planMeta.rescanStatus': 'idle',
        'planMeta.rescanLastRunAt': new Date().toISOString(),
        'planMeta.rescanLastFoundCount': stopsWritten,
        // Recorded so "nothing found" can stop being said when it isn't
        // true — see droppedForDistance.
        'planMeta.rescanLastDroppedTooFar': droppedTooFar,
        // Proposed and then not findable on the map at all — see notLocated.
        'planMeta.rescanLastNotLocated': unlocatable,
        // A run that worked answers the last one that didn't.
        'planMeta.rescanLastError': FieldValue.delete(),
        'planMeta.rescanLastFailedAt': FieldValue.delete(),
      })
      return { stopsWritten, droppedTooFar, notLocated: unlocatable }
    } catch (error) {
      // Cleared on the way out either way: a status left at 'generating' by a
      // failed run would show a spinner forever, which is a worse lie than
      // the error the caller is about to see. A container killed mid-run
      // can't reach this, which is what the staleness check is for.
      //
      // The cause is written next to it, and that is the part that was
      // missing. Until now the only copy of it lived in the promise this is
      // about to reject — so a phone that had stopped following the call
      // (routine: locked screen, switched tab, cellular NAT timeout) lost it
      // entirely, and every failure looked identical from the outside. Three
      // in a row were diagnosed by guesswork for exactly that reason.
      const cause = describeCause(error)
      await tripRef
        .update({
          'planMeta.rescanStatus': 'idle',
          'planMeta.rescanLastError': cause,
          'planMeta.rescanLastFailedAt': new Date().toISOString(),
        })
        .catch((clearError: unknown) =>
          console.warn('Clearing rescanStatus after a failed run failed', clearError),
        )
      if (error instanceof HttpsError) throw error
      // firebase-functions forwards only an HttpsError's message; everything
      // else arrives at the browser as the bare code 'internal' with the
      // message "INTERNAL". exploreHighlightsCallable learned this on
      // 2026-08-12 and this path never did, so every rescan failure — a
      // timeout, an unparseable response, a refused web search, a missing
      // key — reached the traveler as the same sentence, and reached whoever
      // was fixing it as nothing at all. Three consecutive failures were
      // reported and diagnosed by guesswork for exactly this reason.
      console.error(`rescanCorridor failed for trip ${tripId}`, error)
      throw new HttpsError('internal', `Could not rescan: ${cause}`)
    } finally {
      clearInterval(heartbeat)
    }
  },
)
