import { doc, updateDoc } from 'firebase/firestore'
import { db } from './firebase'
import { reverseGeocodeCountry } from './reverseGeocode'
import type { CorridorStopWithId } from '../hooks/useCorridorStops'

/**
 * Fills in the country of stops that never had one.
 *
 * Reported 2026-08-31: *"Seems to not respond to any rebuilds… I can't enter
 * any days either!"* Both symptoms, and a banner that could not be cleared by
 * the button offered to clear it, came from one line: `planSkeleton` drops
 * any stop whose `country` is not exactly two letters, since
 * `overnightStopSchema` requires one and writing a malformed day would
 * surface a long way from here.
 *
 * That filter was right. What was wrong is that **a stop pinned by hand
 * never had a country written at all** — AddCorridorStopForm saved a name,
 * coordinates and nothing else — so every traveler-placed pin was invisible
 * to the day packer for good. It could never be given a day, the "these days
 * are from an earlier plan" banner counted it forever, and the day strip
 * stayed derived, which is why no day could be opened.
 *
 * The form writes a country now. This is for the stops already saved without
 * one, which is most of a trip's hand-placed pins and cannot be fixed by
 * anything the traveler does on the road.
 *
 * Deliberately narrow:
 *
 *  - only stops the day list actually needs — locked, not done;
 *  - a few per pass, because each is a geocode and a trip can carry dozens;
 *  - one field written, and only when the lookup succeeded. A failure leaves
 *    the stop exactly as it was, to be retried next time rather than
 *    stamped with a guess.
 */

/** Enough to unblock a trip quickly without a burst of lookups. */
const MAX_PER_PASS = 5

export function stopsNeedingCountry(
  stops: CorridorStopWithId[],
): CorridorStopWithId[] {
  return stops
    .filter(
      (stop) =>
        stop.status === 'locked' &&
        !stop.doneAt &&
        stop.country?.length !== 2 &&
        Number.isFinite(stop.lat) &&
        Number.isFinite(stop.lng),
    )
    .slice(0, MAX_PER_PASS)
}

export async function fillMissingCountries(
  tripId: string,
  stops: CorridorStopWithId[],
): Promise<number> {
  const needing = stopsNeedingCountry(stops)
  if (needing.length === 0) return 0

  const resolved = await Promise.all(
    needing.map(async (stop) => ({
      stop,
      country: await reverseGeocodeCountry({ lat: stop.lat, lng: stop.lng }),
    })),
  )

  let written = 0
  for (const { stop, country } of resolved) {
    if (!country) continue
    await updateDoc(doc(db, 'trips', tripId, 'corridorStops', stop.id), {
      country,
    })
    written += 1
  }
  return written
}
