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
 * near `center` and writes each surviving find as a new `proposed`
 * corridorStops doc, unlinked to any day — reviewing/locking/discarding a
 * proposed stop is a plain client-side Firestore write (see
 * src/lib/corridorStopActions.ts), same as markSelected. This never touches
 * `committed`/`locked` stops or the days collection, so it needs none of
 * generatePlan.ts/replanTrip.ts's busy-guard machinery — concurrent rescans
 * are merely redundant, not corrupting.
 */
export async function runRescanCorridor(
  tripId: string,
  center: LatLng,
  radiusKm: number,
): Promise<number> {
  const db = getFirestore()
  const tripRef = db.collection('trips').doc(tripId)
  const tripSnap = await tripRef.get()
  if (!tripSnap.exists) {
    throw new HttpsError('not-found', 'Trip not found')
  }
  const trip = tripSnap.data() as Trip

  const finds = await generateRescanCandidates({
    center,
    radiusKm,
    notesFreeText: trip.notes.freeText,
  })

  await Promise.all(
    finds.map((find) =>
      tripRef.collection('corridorStops').add(
        corridorStopSchema.parse({
          name: find.name,
          lat: find.lat,
          lng: find.lng,
          country: find.country,
          why: find.why,
          status: 'proposed',
          linkedDayIds: [],
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
    if (
      typeof tripId !== 'string' ||
      typeof center?.lat !== 'number' ||
      typeof center?.lng !== 'number' ||
      typeof radiusKm !== 'number'
    ) {
      throw new HttpsError(
        'invalid-argument',
        'tripId, center {lat,lng}, and radiusKm are required',
      )
    }
    if (radiusKm <= 0 || radiusKm > MAX_RESCAN_RADIUS_KM) {
      throw new HttpsError(
        'invalid-argument',
        `radiusKm must be between 0 and ${MAX_RESCAN_RADIUS_KM}`,
      )
    }
    const stopsWritten = await runRescanCorridor(tripId, center, radiusKm)
    return { stopsWritten }
  },
)
