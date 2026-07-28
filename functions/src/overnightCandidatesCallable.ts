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
 * Runs one of the three independent lookups fetchOvernightCandidates
 * combines, swallowing its failure to an empty list rather than letting it
 * sink the whole picker. Reported as "Could not load overnight options right
 * now" even though (per the emulator logs) only Overpass had failed —
 * Promise.all rejects as soon as any one of its promises does, so a single
 * flaky third-party source (Overpass has no SLA; Places/Claude can rate-limit
 * or time out too) took campsite and wild-camping results down with it even
 * though those had already succeeded. Each source degrading on its own is
 * the same tradeoff the rest of this app already makes — a haversine
 * fallback when Directions fails, a candidate kept without coordinates when
 * geocoding fails — showing what's actually available beats an all-or-
 * nothing error for a panel whose only job is "here are some options".
 */
async function safe(
  promise: Promise<OvernightStopCandidate[]>,
  label: string,
): Promise<OvernightStopCandidate[]> {
  try {
    return await promise
  } catch (error) {
    console.warn(`Overnight candidates: ${label} failed`, error)
    return []
  }
}

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
    safe(
      searchCampsiteCandidates(near, country, CAMPSITE_CANDIDATE_COUNT),
      'campsite search (Places)',
    ),
    safe(
      searchStellplatzCandidates(near, country, STELLPLATZ_CANDIDATE_COUNT),
      'stellplatz search (Overpass)',
    ),
    safe(
      generateClaudeOvernightCandidates({
        kind: 'wild',
        near,
        country,
        freeCampingRules,
      }),
      'wild camping generation (Claude)',
    ),
  ])

  // Places has decent commercial-campsite coverage everywhere, but OSM's
  // stellplatz tagging is real but inconsistently mapped by country — fall
  // back to Claude+web_search only where OSM genuinely found nothing.
  const stellplatz =
    stellplatzFromOsm.length > 0
      ? stellplatzFromOsm
      : await safe(
          generateClaudeOvernightCandidates({
            kind: 'stellplatz',
            near,
            country,
            freeCampingRules,
          }).then((results) => results.slice(0, STELLPLATZ_CANDIDATE_COUNT)),
          'stellplatz fallback generation (Claude)',
        )

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
