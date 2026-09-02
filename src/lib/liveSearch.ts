import { httpsCallable } from 'firebase/functions'
import { doc, getDoc, updateDoc } from 'firebase/firestore'
import { db } from './firebase'
import type { LatLng } from '@rv/shared'
import { functions } from './firebase'
import type { ClaudeFailureKind, SearchSource } from './searchSourceNote'

/**
 * "What's around us now."
 *
 * Requested 2026-08-23: "I would like to have a live function, which is
 * basically find things around us now. The input should be the already
 * predetermined ones from detailed planning (breakfast/lunch/dinner/
 * activity, but also free text). The notes should be taken as input for
 * each."
 *
 * Deliberately its own action rather than a mode of the rescan: this one
 * writes NOTHING. Someone looking for lunch three times a day would
 * otherwise fill their corridor with pins they never chose, which is the
 * opposite of curation.
 */
export interface LiveFind {
  name: string
  lat: number
  lng: number
  country: string
  why: string
  googleMapsUrl?: string
  photoUrl?: string
}

/**
 * The presets, which are the same vocabulary the day-by-day plan already
 * uses — breakfast/lunch/dinner are `Meal`, and "something to do" is what
 * the activity search means. Phrased as the traveler would say it out loud,
 * because it reaches Claude as a query verbatim.
 */
export const LIVE_PRESETS = [
  { id: 'breakfast', label: 'Breakfast', query: 'somewhere for breakfast or good coffee nearby' },
  { id: 'lunch', label: 'Lunch', query: 'a good lunch place nearby' },
  { id: 'dinner', label: 'Dinner', query: 'a good dinner place nearby' },
  { id: 'activity', label: 'Something to do', query: 'something worth doing nearby right now' },
  { id: 'sleep', label: 'Somewhere to sleep', query: 'a campsite, stellplatz or motorhome parking nearby' },
] as const

/**
 * The fallback radius, used only when a caller does not say.
 *
 * Was the ONLY radius until 2026-08-24, and reported as the reason results
 * felt distant: "currently the results are a bit too far away, so it needs to
 * be given the option to specify radius of search as well." 25 km is a
 * sensible planning distance and a ridiculous one for finding lunch.
 */
export const LIVE_RADIUS_KM = 25

export async function searchAroundUs(
  tripId: string,
  center: LatLng,
  query: string,
  radiusKm: number = LIVE_RADIUS_KM,
): Promise<LiveResult> {
  const call = httpsCallable<
    { tripId: string; center: LatLng; radiusKm: number; query: string },
    LiveResult
  >(functions, 'searchNearby')
  const { data } = await call({
    tripId,
    center,
    radiusKm,
    query,
  })
  return {
    finds: data.finds,
    // Older deployments answered without a source at all. Treated as "not
    // reported" rather than as Places, so a stale function version says
    // nothing instead of accusing itself.
    ...(data.source ? { source: data.source } : {}),
    ...(data.claudeFailure ? { claudeFailure: data.claudeFailure } : {}),
  }
}

/**
 * Removes a find from the saved scratch list.
 *
 * Called when a find is added to the trip: it has stopped being a
 * suggestion and become a stop, and leaving it in both places would offer
 * the traveler the chance to add it twice.
 */
export async function dropFindFromScratch(
  tripId: string,
  name: string,
): Promise<void> {
  const ref = doc(db, 'trips', tripId, 'scratch', 'lastSearch')
  const snap = await getDoc(ref)
  if (!snap.exists()) return
  const finds = (snap.data() as { finds?: { name: string }[] }).finds ?? []
  await updateDoc(ref, { finds: finds.filter((find) => find.name !== name) })
}

/**
 * The finds plus WHICH ENGINE found them.
 *
 * Carried out of the callable because a fallback the traveler cannot see is
 * indistinguishable from a regression — see searchSourceNote for the report
 * that proved it.
 */
export interface LiveResult {
  finds: LiveFind[]
  source?: SearchSource
  claudeFailure?: ClaudeFailureKind
}
