import { getFirestore } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/https'
import { corridorStopSchema, type LatLng, type Trip } from '@rv/shared'
import { googlePlacesApiKey } from './placesApi.js'
import {
  MAX_RESCAN_RADIUS_KM,
  claudeApiKey,
  generateRescanCandidates,
} from './prompts/rescanCorridor.js'

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
): Promise<number> {
  const db = getFirestore()
  const tripRef = db.collection('trips').doc(tripId)
  const tripSnap = await tripRef.get()
  if (!tripSnap.exists) {
    throw new HttpsError('not-found', 'Trip not found')
  }
  const trip = tripSnap.data() as Trip
  const isExploring = trip.planMeta.status === 'idle'

  const finds = await generateRescanCandidates({
    center,
    radiusKm,
    notesFreeText: trip.notes.freeText,
    tripId,
    query,
    backbone,
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

  return finds.length
}

export const rescanCorridor = onCall(
  { secrets: [claudeApiKey, googlePlacesApiKey] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be signed in')
    }
    const tripId = request.data?.tripId
    const center = request.data?.center as LatLng | undefined
    const radiusKm = request.data?.radiusKm
    const query = request.data?.query
    const backbone = request.data?.backbone as LatLng[] | undefined
    if (
      typeof tripId !== 'string' ||
      typeof center?.lat !== 'number' ||
      typeof center?.lng !== 'number' ||
      typeof radiusKm !== 'number' ||
      (query !== undefined && typeof query !== 'string') ||
      (backbone !== undefined &&
        (!Array.isArray(backbone) ||
          backbone.some((p) => typeof p?.lat !== 'number' || typeof p?.lng !== 'number')))
    ) {
      throw new HttpsError(
        'invalid-argument',
        'tripId, center {lat,lng}, and radiusKm are required; query, if given, must be a string; backbone, if given, must be an array of {lat,lng}',
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
    const stopsWritten = await runRescanCorridor(
      tripId,
      center,
      radiusKm,
      query?.trim() || undefined,
      backbone,
    )
    return { stopsWritten }
  },
)
