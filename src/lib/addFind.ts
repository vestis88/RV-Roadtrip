import { addDoc, collection } from 'firebase/firestore'
import type { LiveFind } from './liveSearch'
import { db } from './firebase'

/**
 * Saving one search result as an ordinary candidate.
 *
 * Extracted from ExploreMapScreen on 2026-08-25 after "At restart, the added
 * results are gone" — a claim about persistence that no test could settle
 * while the write lived inline in a screen. It is a lib with a test now, so
 * what it writes is a fact rather than an argument.
 *
 * The stop is written exactly as a hand-dropped pin would be: `candidate`,
 * `origin: 'traveler'`, no day links. The board decides what happens next,
 * which is the whole point of the finds being ephemeral until this is called.
 */
export async function addFindToTrip(
  tripId: string,
  find: LiveFind,
): Promise<void> {
  // Every optional field is spread conditionally rather than passed as
  // `undefined`: Firestore rejects an undefined field value outright, so one
  // find without a photo would throw and take the whole add with it.
  await addDoc(collection(db, 'trips', tripId, 'corridorStops'), {
    name: find.name,
    lat: find.lat,
    lng: find.lng,
    // A stop with no country cannot become an overnight — the schema wants
    // two letters — and writing a malformed one would surface a long way
    // from here, in the day pipeline.
    country: find.country ?? 'XX',
    why: find.why ?? '',
    ...(find.googleMapsUrl ? { googleMapsUrl: find.googleMapsUrl } : {}),
    ...(find.photoUrl ? { photoUrl: find.photoUrl } : {}),
    status: 'candidate',
    linkedDayIds: [],
    priority: 'worth-a-detour',
    rank: 0,
    origin: 'traveler',
  })
}
