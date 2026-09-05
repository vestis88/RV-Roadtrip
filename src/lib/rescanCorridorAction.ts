import { httpsCallable } from 'firebase/functions'
import {
  boundsHalfDiagonalKm,
  shrinkBoundsToFit,
  type LatLng,
  type MapBounds,
} from '@rv/shared'
import { functions } from './firebase'
import { SEARCH_CALLABLE_TIMEOUT_MS } from './callableTimeouts'
import { MAX_RESCAN_RADIUS_KM } from './rescanRadius'

export { MAX_RESCAN_RADIUS_KM, RESCAN_RADIUS_KM } from './rescanRadius'

/**
 * How far "this area" actually reaches, from what the traveler can see.
 *
 * The button says "Rescan this area" over a map, and the area it searched
 * was a fixed 25 km circle around the centre no matter what was on screen.
 * On the report that prompted this the visible map ran from Båstad to
 * Markaryd — some 80 km across — so most of what the traveler was pointing
 * at was never searched, and any find from the visible-but-unsearched part
 * was discarded on arrival. A search that runs for minutes and then answers
 * "nothing nearby" about ground it never looked at is not a slow search; it
 * is the wrong search.
 *
 * Measured to the corner rather than the edge, so everything visible is
 * inside it, and capped at the server's own limit — with the cap reported
 * rather than applied quietly, because silently searching less than the
 * traveler is looking at is the bug being fixed.
 */
export function visibleRadiusKm(bounds: MapBounds): {
  radiusKm: number
  cappedFrom?: number
} {
  const visible = Math.max(1, Math.round(boundsHalfDiagonalKm(bounds)))
  return visible > MAX_RESCAN_RADIUS_KM
    ? { radiusKm: MAX_RESCAN_RADIUS_KM, cappedFrom: visible }
    : { radiusKm: visible }
}

/**
 * The area a search will actually cover — as a rectangle, which is what the
 * traveler is looking at.
 *
 * Asked for on 2026-09-05: *"Don't lock yourself to a circle if a rectangle
 * would work better."* The circle was never a decision; it was what survived
 * measuring the viewport and keeping only one number. Everything downstream
 * can take the shape now — Places restricts a text search to a rectangle
 * natively at any size, the find filter asks "is it inside this?", and the
 * prompt describes it by its corners — so the shape the map draws, the shape
 * Google searches and the shape the answer is measured against are finally
 * the same object.
 *
 * The cost cap is unchanged and still measured centre-to-corner: a rectangle
 * that reaches further than MAX_RESCAN_RADIUS_KM is shrunk about its centre
 * rather than refused, exactly as the circle was.
 */
export function visibleSearchArea(bounds: MapBounds): {
  bounds: MapBounds
  radiusKm: number
  cappedFrom?: number
} {
  const half = Math.max(1, Math.round(boundsHalfDiagonalKm(bounds)))
  if (half <= MAX_RESCAN_RADIUS_KM) return { bounds, radiusKm: half }
  return {
    bounds: shrinkBoundsToFit(bounds, MAX_RESCAN_RADIUS_KM),
    radiusKm: MAX_RESCAN_RADIUS_KM,
    cappedFrom: half,
  }
}

/**
 * Searches near `center` for stops worth adding to the corridor, writing
 * any finds as new `proposed`/`candidate` corridorStops for review (see
 * rescanCorridorCallable.ts). Shared by RescanCorridorButton's plain "what's
 * worth stopping for nearby" pass and AddCorridorStopForm's "describe what
 * you want" mode — same callable, `query` just narrows what it looks for.
 *
 * `backbone`, when given (the explore-mode route corridor — start, locked
 * stops, end, already in route order), switches the server-side filter from
 * "within radiusKm of center" to "a small detour off this route" instead —
 * see rescanCorridorCallable.ts's own doc comment. `center`/`radiusKm` are
 * still required either way (used as the geocoding bias point).
 */
export async function rescanCorridorArea(
  tripId: string,
  center: LatLng,
  radiusKm: number,
  query?: string,
  backbone?: LatLng[],
  // Place NAMES for the same geography (2026-08-02) — "Hillerød, Denmark"
  // for the centre, the route's own stop names for the corridor. The search
  // prompt used to receive only coordinates, which left the model working
  // out where it had been sent before it could search for anything there;
  // see reverseGeocode.ts for the reported four-minute version of that.
  // Both optional: without them the prompt falls back to coordinates.
  centerName?: string,
  waypointNames?: string[],
  // The rectangle actually on screen, and its corners in names. Both
  // optional: without them the server does the circle search it always did,
  // which is what an older client still gets.
  bounds?: MapBounds,
  areaCorners?: AreaCorners,
): Promise<{ stopsWritten: number }> {
  const call = httpsCallable<
    {
      tripId: string
      center: LatLng
      radiusKm: number
      query?: string
      backbone?: LatLng[]
      centerName?: string
      waypointNames?: string[]
      bounds?: MapBounds
      areaCorners?: AreaCorners
    },
    { stopsWritten: number }
  >(functions, 'rescanCorridor', { timeout: SEARCH_CALLABLE_TIMEOUT_MS })
  const result = await call({
    tripId,
    center,
    radiusKm,
    ...(query ? { query } : {}),
    ...(backbone && backbone.length >= 2 ? { backbone } : {}),
    ...(centerName ? { centerName } : {}),
    ...(waypointNames && waypointNames.length > 0 ? { waypointNames } : {}),
    ...(bounds ? { bounds } : {}),
    ...(areaCorners && Object.keys(areaCorners).length > 0
      ? { areaCorners }
      : {}),
  })
  return result.data
}

/** The visible rectangle's corners, named — see nameAreaCorners. */
export interface AreaCorners {
  northWest?: string
  northEast?: string
  southWest?: string
  southEast?: string
}
