import type { LatLng, NamedPoint, SharedTripStop } from '@rv/shared'

/**
 * A point the traveler never filled in comes back as an empty name at
 * (0, 0), which is a spot in the Atlantic — drawing it would put the whole
 * map in the Gulf of Guinea and the real route in a corner. Same guard as
 * validateRoute's isLocated, for the same reason.
 */
export function isLocated(point: NamedPoint): boolean {
  return point.name.trim() !== '' && !(point.lat === 0 && point.lng === 0)
}

/**
 * The family view's route as a sequence of points: where the travelers set
 * off, every stop they committed to in driving order, and where they
 * finish.
 *
 * Its own module rather than part of SharedTripMap because it is the only
 * part of that map with a decision in it, and the only part testable
 * without a Maps API key — which not every environment the tests run in
 * has.
 */
export function sharedRoutePoints(
  stops: SharedTripStop[],
  startPoint: NamedPoint,
  endPoint: NamedPoint,
): LatLng[] {
  const ordered: LatLng[] = []
  if (isLocated(startPoint)) ordered.push({ lat: startPoint.lat, lng: startPoint.lng })
  for (const stop of stops) ordered.push({ lat: stop.lat, lng: stop.lng })
  if (isLocated(endPoint)) ordered.push({ lat: endPoint.lat, lng: endPoint.lng })
  return ordered
}
