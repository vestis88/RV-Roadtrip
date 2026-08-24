import type { LatLng } from '@rv/shared'
import { isTripActiveToday } from './executionMode'

/**
 * Where the route starts FROM.
 *
 * Requested 2026-08-24: "The next stop in plan should be routed from our
 * current location."
 *
 * Two gates and one quantiser, and each of them is load-bearing.
 *
 * **Only while the trip is running.** Planning a German trip from a sofa in
 * Sweden would otherwise route it from Sweden, and every number on the board
 * — the driving total, the day budget, the arrival estimates — is derived
 * from that first leg. `isTripActiveToday` already exists and is pure.
 *
 * **Only with a position.** Obvious, and stated because falling back to the
 * start point has to be the default rather than an error state: someone who
 * refused the permission prompt gets the ordinary planning route, silently.
 *
 * **Quantised, which is the subtle one.** `useCurrentPosition` watches
 * rather than samples, so it emits a fresh object on every GPS fix — and
 * DirectionsRoute lists its points in an effect dependency array. Feeding it
 * a new origin per fix fires a Directions request per fix, which is the
 * self-sustaining request loop that once made this map impossible to pan
 * (see askedBackbone's note on the same failure). A van that has not moved a
 * kilometre has not changed which way it should drive.
 *
 * Done by SNAPPING TO A GRID rather than by remembering the last origin and
 * measuring against it. The first version did the latter, and it needed the
 * previous value written back during render — which React forbids for good
 * reason, and which lint caught. Rounding is a pure function of the
 * position: the same fix always yields the same cell, so a `useMemo` keyed
 * on the rounded numbers gives a stable object with nothing remembered
 * anywhere. The cost is that a van sitting exactly on a cell boundary can
 * flip between two neighbours; that is one extra Directions request in a
 * rare case, against a class of bug that has already bitten this file once.
 */

/**
 * Grid size, in degrees. 0.01° is about 1.1 km of latitude, and about 0.75
 * km of longitude at Alpine latitudes — near enough "a kilometre" for a
 * decision about which way to drive.
 */
export const ORIGIN_GRID_DEGREES = 0.01

/** The position snapped to the grid — see the note above on why. */
export function quantisePosition(position: {
  lat: number
  lng: number
}): { lat: number; lng: number } {
  const snap = (value: number) =>
    Math.round(value / ORIGIN_GRID_DEGREES) * ORIGIN_GRID_DEGREES
  return { lat: snap(position.lat), lng: snap(position.lng) }
}

export interface RouteOriginInput {
  startPoint: LatLng & { name: string }
  /** Already quantised — see quantisePosition. */
  position: { lat: number; lng: number } | null
  startDate: string
  endDate: string
  today: string
}

export interface RouteOrigin {
  point: LatLng & { name: string }
  /** True when this is the traveler's position rather than the trip's start. */
  fromPosition: boolean
}

export function routeOriginFor(input: RouteOriginInput): RouteOrigin {
  const { startPoint, position, startDate, endDate, today } = input

  if (!position || !isTripActiveToday(today, startDate, endDate)) {
    return { point: startPoint, fromPosition: false }
  }
  return {
    point: { lat: position.lat, lng: position.lng, name: CURRENT_POSITION_NAME },
    fromPosition: true,
  }
}

/**
 * The name carried by a position-derived origin.
 *
 * A constant rather than a formatted coordinate, because it is compared
 * above to decide whether the previous origin was itself a position — and
 * because it ends up in the drive leg of a written day, where "Where we
 * were" is a better sentence than a pair of decimals.
 */
export const CURRENT_POSITION_NAME = 'Where we are'
