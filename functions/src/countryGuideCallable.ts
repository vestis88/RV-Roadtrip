import { getFirestore } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/https'
import type { TripSettings } from '@rv/shared'
import { claudeApiKey, generateCountryGuide } from './prompts/countryGuide.js'

export async function refreshCountryGuideForTrip(
  tripId: string,
  countryCode: string,
): Promise<void> {
  const db = getFirestore()
  const tripSnap = await db.collection('trips').doc(tripId).get()
  const settings = tripSnap.data()?.settings as TripSettings | undefined
  if (!settings) {
    throw new HttpsError('not-found', 'Trip not found')
  }

  const guide = await generateCountryGuide({
    countryCode,
    vehicle: settings.vehicle,
  })

  await db
    .collection('trips')
    .doc(tripId)
    .collection('countries')
    .doc(countryCode)
    .set(guide)
}

export const refreshCountryGuide = onCall(
  { secrets: [claudeApiKey] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be signed in')
    }
    const tripId = request.data?.tripId
    const countryCode = request.data?.countryCode
    if (typeof tripId !== 'string' || typeof countryCode !== 'string') {
      throw new HttpsError(
        'invalid-argument',
        'tripId and countryCode are required',
      )
    }
    await refreshCountryGuideForTrip(tripId, countryCode)
    return { countryCode }
  },
)
