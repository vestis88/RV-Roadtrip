import { httpsCallable } from 'firebase/functions'
import type { LatLng } from '@rv/shared'
import { functions } from './firebase'

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

/** How far around the van to look. Walking-to-short-drive, not planning. */
export const LIVE_RADIUS_KM = 25

export async function searchAroundUs(
  tripId: string,
  center: LatLng,
  query: string,
): Promise<LiveFind[]> {
  const call = httpsCallable<
    { tripId: string; center: LatLng; radiusKm: number; query: string },
    { finds: LiveFind[] }
  >(functions, 'searchNearby')
  const { data } = await call({
    tripId,
    center,
    radiusKm: LIVE_RADIUS_KM,
    query,
  })
  return data.finds
}
