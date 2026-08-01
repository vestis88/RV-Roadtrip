import { getFirestore } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/https'
import type { TripSettings } from '@rv/shared'
import { requireTripMember } from './authz.js'
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
    tripId,
  })

  await db
    .collection('trips')
    .doc(tripId)
    .collection('countries')
    .doc(countryCode)
    .set(guide)
}

export const refreshCountryGuide = onCall(
  {
    secrets: [claudeApiKey],
    // Same reasoning as exploreHighlightsCallable.ts: the underlying Claude
    // call retries (MAX_ATTEMPTS) and uses web_search (up to 8 uses), which
    // can plausibly exceed the 60s default.
    timeoutSeconds: 180,
  },
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
    await requireTripMember(tripId, request.auth.uid)
    await refreshCountryGuideForTrip(tripId, countryCode)
    return { countryCode }
  },
)
