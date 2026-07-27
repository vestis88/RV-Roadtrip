import { getFirestore } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/https'
import type { CountryGuide, OvernightStopCandidate, TripDay } from '@rv/shared'
import { googlePlacesApiKey, searchCampsiteCandidates } from './placesApi.js'
import { searchStellplatzCandidates } from './overpassApi.js'
import {
  claudeApiKey,
  generateClaudeOvernightCandidates,
} from './prompts/overnightCandidates.js'

const CAMPSITE_CANDIDATE_COUNT = 3
const STELLPLATZ_CANDIDATE_COUNT = 2
const WILD_CANDIDATE_COUNT = 2

/**
 * Overnight-stop candidates (implemented 2026-07-27): resolved lazily, only
 * when the traveler opens "Change overnight" on Day View for a specific
 * day — most days' AI-picked default is never questioned, so resolving
 * candidates for every day at generation time would mean paying the
 * Places/Overpass/Claude cost for stops nobody ever looks at twice.
 */
export async function fetchOvernightCandidates(
  tripId: string,
  dayId: string,
): Promise<OvernightStopCandidate[]> {
  const db = getFirestore()
  const dayRef = db.collection('trips').doc(tripId).collection('days').doc(dayId)
  const daySnap = await dayRef.get()
  const day = daySnap.data() as TripDay | undefined
  if (!day) {
    throw new HttpsError('not-found', 'Day not found')
  }

  const near = { lat: day.overnight.lat, lng: day.overnight.lng }
  const country = day.overnight.country

  const guideSnap = await db
    .collection('trips')
    .doc(tripId)
    .collection('countries')
    .doc(country)
    .get()
  const freeCampingRules = (guideSnap.data() as CountryGuide | undefined)
    ?.freeCampingRules

  const [campsites, stellplatzFromOsm, wild] = await Promise.all([
    searchCampsiteCandidates(near, country, CAMPSITE_CANDIDATE_COUNT),
    searchStellplatzCandidates(near, country, STELLPLATZ_CANDIDATE_COUNT),
    generateClaudeOvernightCandidates({
      kind: 'wild',
      near,
      country,
      freeCampingRules,
    }),
  ])

  // Places has decent commercial-campsite coverage everywhere, but OSM's
  // stellplatz tagging is real but inconsistently mapped by country — fall
  // back to Claude+web_search only where OSM genuinely found nothing.
  const stellplatz =
    stellplatzFromOsm.length > 0
      ? stellplatzFromOsm
      : await generateClaudeOvernightCandidates({
          kind: 'stellplatz',
          near,
          country,
          freeCampingRules,
        }).then((results) => results.slice(0, STELLPLATZ_CANDIDATE_COUNT))

  return [...campsites, ...stellplatz, ...wild.slice(0, WILD_CANDIDATE_COUNT)]
}

export const getOvernightCandidates = onCall(
  { secrets: [claudeApiKey, googlePlacesApiKey] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be signed in')
    }
    const tripId = request.data?.tripId
    const dayId = request.data?.dayId
    if (typeof tripId !== 'string' || typeof dayId !== 'string') {
      throw new HttpsError('invalid-argument', 'tripId and dayId are required')
    }
    const candidates = await fetchOvernightCandidates(tripId, dayId)
    return { candidates }
  },
)
