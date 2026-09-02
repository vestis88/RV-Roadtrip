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

/**
 * How near a stop with a known country has to be for its country to be
 * borrowed.
 *
 * Reported twice on 2026-09-01 — "3 of them are still having their country
 * looked up" was still on screen an hour after the geocoder was supposed to
 * fix it. Depending on a network call for the ONE field that decides whether
 * a stop can exist in the day list at all was the mistake: on a phone at a
 * campsite the call is exactly what fails.
 *
 * The stops around it already answer the question. A pin dropped by hand
 * sits among the stops it was dropped between, and on a road trip those are
 * in the same country as it — 50 km is close enough to be confident and far
 * enough to cover the gap between two stops on one leg. A wrong flag on an
 * overnight is a small cost; a stop that can never be given a day is not.
 */
const NEIGHBOUR_RADIUS_KM = 50

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

/**
 * The country of the nearest stop that has one, when it is near enough.
 *
 * Exported for its own test: this is a GUESS, unlike the geocode, and the
 * radius is the whole of what makes it a safe one.
 */
export function countryFromNeighbours(
  stop: { lat: number; lng: number },
  stops: CorridorStopWithId[],
): string | undefined {
  let best: { country: string; km: number } | undefined
  for (const other of stops) {
    if (other.country?.length !== 2) continue
    const km = haversineKm(stop, other)
    if (km > NEIGHBOUR_RADIUS_KM) continue
    if (!best || km < best.km) best = { country: other.country, km }
  }
  return best?.country
}

/** Great-circle distance, the same formula the rest of the app uses. */
function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 6371 * 2 * Math.asin(Math.sqrt(h))
}

export async function fillMissingCountries(
  tripId: string,
  stops: CorridorStopWithId[],
  /**
   * Whether the Maps geocoder has loaded. False on a cold start, on a
   * blocked network, and in any environment without a Maps key — all of
   * which used to leave the stop undatable forever, since the geocode was
   * the only answer.
   */
  canGeocode: boolean,
): Promise<number> {
  const needing = stopsNeedingCountry(stops)
  if (needing.length === 0) return 0

  const resolved = await Promise.all(
    needing.map(async (stop) => ({
      stop,
      // Exact first, where it is available at all; the neighbours are the
      // answer when it is not.
      country:
        (canGeocode
          ? await reverseGeocodeCountry({ lat: stop.lat, lng: stop.lng })
          : undefined) ?? countryFromNeighbours(stop, stops),
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
