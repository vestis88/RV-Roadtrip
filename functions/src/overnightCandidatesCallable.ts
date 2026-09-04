import { getFirestore } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/https'
import type { LatLng, OvernightStopCandidate, TripDay } from '@rv/shared'
import { requireAccess } from './accessControl.js'
import { requireTripMember } from './authz.js'
import { describeCause } from './describeCause.js'
import { loadFreeCampingRulesByCountry } from './countryGuideSections.js'
import { findNearbyCampsites, googlePlacesApiKey } from './placesApi.js'
import { searchStellplatzCandidates } from './overpassApi.js'
import {
  claudeApiKey,
  generateClaudeOvernightCandidates,
} from './prompts/overnightCandidates.js'

const CAMPSITE_CANDIDATE_COUNT = 3
const STELLPLATZ_CANDIDATE_COUNT = 2
const WILD_CANDIDATE_COUNT = 2

/**
 * How long any one source gets before the picker stops waiting for it.
 *
 * `safe` above converts a source that *fails* into an empty list. It does
 * nothing about a source that never settles, and Promise.all waits for the
 * slowest — so one stalled source took the whole callable to its 180s ceiling
 * and Cloud Run killed the request. That is what "Could not load overnight
 * options right now" actually was, every time: not an exception, a 504.
 * Production logs for 2026-08-10 show two of them at latency 179.9999s
 * against `timeoutSeconds: 180`.
 *
 * Overpass has no SLA and is the usual culprit, but the Claude calls use web
 * search, which routinely runs to minutes — rescanCorridor.ts carries its own
 * RETRY_DEADLINE_MS for exactly that reason.
 *
 * Budgeted so the worst case (parallel phase, then the conditional
 * stellplatz fallback) lands comfortably inside the callable's own ceiling
 * with room for the Firestore reads either side.
 */
const SOURCE_TIMEOUT_MS = 60_000
const FALLBACK_TIMEOUT_MS = 45_000

/**
 * Runs one of the independent lookups fetchOvernightCandidates combines,
 * degrading it to an empty list if it fails OR if it takes too long — slow
 * and broken are the same thing to a traveler looking at a spinner.
 *
 * This replaces an earlier `safe` helper that handled only failure. That one
 * was written after Promise.all's reject-on-first-failure let a single
 * Overpass 406 sink results the other two sources had already produced; the
 * principle it established — each source degrades on its own, showing what
 * is actually available beats an all-or-nothing error — is the same one
 * extended here to cover a source that never answers at all.
 *
 * The abandoned promise is deliberately not cancelled: the sources have no
 * abort plumbing today, and adding it is a bigger change than this fix
 * needs. Its result is simply discarded. `.catch` is attached so a rejection
 * arriving after we stopped listening cannot surface as an unhandled
 * rejection and take the instance down.
 */
async function withDeadline(
  promise: Promise<OvernightStopCandidate[]>,
  label: string,
  timeoutMs: number,
): Promise<OvernightStopCandidate[]> {
  let timer: NodeJS.Timeout | undefined
  const guarded = promise.catch((error) => {
    console.warn(`Overnight candidates: ${label} failed`, error)
    return [] as OvernightStopCandidate[]
  })
  try {
    return await Promise.race([
      guarded,
      new Promise<OvernightStopCandidate[]>((resolve) => {
        timer = setTimeout(() => {
          console.warn(
            `Overnight candidates: ${label} exceeded ${timeoutMs}ms — continuing without it`,
          )
          resolve([])
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Exported for unit tests only. The deadline is the whole fix and it is pure
 * timing logic with no network in it — the production failure it addresses
 * takes three minutes to reproduce for real.
 */
export const __testing = { withDeadline }

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

  return overnightCandidatesNear(
    { lat: day.overnight.lat, lng: day.overnight.lng },
    day.overnight.country,
    tripId,
  )
}

/**
 * The same three kinds of bed, around any point at all.
 *
 * Requested 2026-08-23: "Every activity should get a suggested
 * camping/stellplatz/free camping at the push of a button." Which is how the
 * decision is actually made on an RV trip — you pick the sight, then find
 * somewhere to sleep near it — and the reverse of how this code was shaped,
 * which resolved beds per DAY because days were the only thing that existed.
 *
 * Almost nothing had to change: everything below already worked from a
 * coordinate and a country, and reading them off a day was the only part
 * that did not. So the day path above is now one caller of this, and a
 * corridor stop is another.
 */
export async function overnightCandidatesNear(
  near: LatLng,
  country: string,
  tripId: string,
): Promise<OvernightStopCandidate[]> {
  // The wild-camping prompt is meaningfully better with the country's own
  // free-camping rules in hand, and degrades to generic advice without them
  // rather than failing. Shares the overnight pass's loader (which swallows
  // its own per-country failures, so a Firestore hiccup here cannot be the
  // thing that fails the picker) so the prose the picker shows and the rules
  // the planner commits nights on can never come from different documents.
  const freeCampingRules = (await loadFreeCampingRulesByCountry([country])).get(
    country,
  )

  const [campsites, stellplatzFromOsm, wild] = await Promise.all([
    withDeadline(
      findNearbyCampsites(near, country, CAMPSITE_CANDIDATE_COUNT),
      'campsite search (Places)',
      SOURCE_TIMEOUT_MS,
    ),
    withDeadline(
      searchStellplatzCandidates(near, country, STELLPLATZ_CANDIDATE_COUNT),
      'stellplatz search (Overpass)',
      SOURCE_TIMEOUT_MS,
    ),
    withDeadline(
      generateClaudeOvernightCandidates({
        kind: 'wild',
        near,
        country,
        freeCampingRules,
        tripId,
      }),
      'wild camping generation (Claude)',
      SOURCE_TIMEOUT_MS,
    ),
  ])

  // Places has decent commercial-campsite coverage everywhere, but OSM's
  // stellplatz tagging is real but inconsistently mapped by country — fall
  // back to Claude+web_search only where OSM genuinely found nothing.
  const stellplatz =
    stellplatzFromOsm.length > 0
      ? stellplatzFromOsm
      : await withDeadline(
          generateClaudeOvernightCandidates({
            kind: 'stellplatz',
            near,
            country,
            freeCampingRules,
            tripId,
          }).then((results) => results.slice(0, STELLPLATZ_CANDIDATE_COUNT)),
          'stellplatz fallback generation (Claude)',
          FALLBACK_TIMEOUT_MS,
        )

  return [...campsites, ...stellplatz, ...wild.slice(0, WILD_CANDIDATE_COUNT)]
}

/**
 * Somewhere to sleep near a corridor stop, rather than near a day.
 *
 * Separate from the day callable rather than folded into it: the two take
 * different ids, resolve different documents, and a single callable taking
 * "one of these two" would have to validate that anyway. They share the part
 * that matters — overnightCandidatesNear — which is where all the cost and
 * all the judgement live.
 */
export const getStopOvernightCandidates = onCall(
  {
    secrets: [claudeApiKey, googlePlacesApiKey],
    timeoutSeconds: 180,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be signed in')
    }
    requireAccess(request.auth)
    const tripId = request.data?.tripId
    const stopId = request.data?.stopId
    if (typeof tripId !== 'string' || typeof stopId !== 'string') {
      throw new HttpsError('invalid-argument', 'tripId and stopId are required')
    }
    await requireTripMember(tripId, request.auth.uid)

    const stopSnap = await getFirestore()
      .collection('trips')
      .doc(tripId)
      .collection('corridorStops')
      .doc(stopId)
      .get()
    const stop = stopSnap.data() as
      | { lat?: number; lng?: number; country?: string }
      | undefined
    if (!stop || typeof stop.lat !== 'number' || typeof stop.lng !== 'number') {
      throw new HttpsError('not-found', 'Stop not found')
    }
    // Without a country there are no free-camping rules to reason with, and
    // the wild-camping half would be answering about nowhere in particular.
    if (stop.country?.length !== 2) {
      throw new HttpsError(
        'failed-precondition',
        'This stop has no country, so there is nothing to check the local camping rules against.',
      )
    }

    const candidates = await overnightCandidatesNear(
      { lat: stop.lat, lng: stop.lng },
      stop.country,
      tripId,
    )
    return { candidates }
  },
)

export const getOvernightCandidates = onCall(
  {
    secrets: [claudeApiKey, googlePlacesApiKey],
    // Runs Places + Overpass + Claude in parallel, then a second sequential
    // Claude call when OSM finds nothing — the worst case of the four
    // Claude-calling callables in this file, so needs the same headroom
    // exploreHighlightsCallable.ts's own doc comment explains.
    timeoutSeconds: 180,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be signed in')
    }
    requireAccess(request.auth)
    const tripId = request.data?.tripId
    const dayId = request.data?.dayId
    if (typeof tripId !== 'string' || typeof dayId !== 'string') {
      throw new HttpsError('invalid-argument', 'tripId and dayId are required')
    }
    await requireTripMember(tripId, request.auth.uid)
    try {
      const candidates = await fetchOvernightCandidates(tripId, dayId)
      return { candidates }
    } catch (error) {
      // Anything not already an HttpsError reaches the browser as the bare
      // word "internal" — the trap rescanCorridorCallable.ts documents, and
      // what a traveler saw on 2026-09-03 when the row failed. The commonest
      // cause this week is the Claude account being out of credit, which no
      // amount of pressing the button again will fix, so say it.
      if (error instanceof HttpsError) throw error
      console.error('getOvernightCandidates failed', error)
      throw new HttpsError(
        'internal',
        `Could not look for places to sleep: ${describeCause(error)}`,
      )
    }
  },
)
