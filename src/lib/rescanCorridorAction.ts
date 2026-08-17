import { httpsCallable } from 'firebase/functions'
import { haversineDistanceKm, type LatLng } from '@rv/shared'
import { functions } from './firebase'
import { SEARCH_CALLABLE_TIMEOUT_MS } from './callableTimeouts'

/**
 * The fallback when the map hasn't reported its bounds yet. Everything else
 * uses the viewport — see visibleRadiusKm.
 */
export const RESCAN_RADIUS_KM = 25

/**
 * The callable's own cap, mirrored so the client can say when it bites.
 *
 * Raised from 50 on 2026-08-17, because what set it at 50 no longer applies.
 * It was a cost guard from when a rescan ran up to three web searches per
 * turn and the bill grew with the ground covered. The search is now one
 * tool-free Claude call returning at most MAX_RESCAN_RESULTS finds, and that
 * costs the same whether it is asked about 25 km or 150. What remains is a
 * quality bound — "what is worth stopping for within 500 km of here" is a
 * worse question than "within 100 km", not a more expensive one — so the cap
 * stays, at a size that covers a normal regional view instead of a city one.
 */
export const MAX_RESCAN_RADIUS_KM = 150

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
export function visibleRadiusKm(bounds: {
  north: number
  south: number
  east: number
  west: number
}): { radiusKm: number; cappedFrom?: number } {
  const center = {
    lat: (bounds.north + bounds.south) / 2,
    lng: (bounds.east + bounds.west) / 2,
  }
  const corner = { lat: bounds.north, lng: bounds.east }
  const radiusKm = Math.max(1, Math.round(haversineDistanceKm(center, corner)))
  return radiusKm > MAX_RESCAN_RADIUS_KM
    ? { radiusKm: MAX_RESCAN_RADIUS_KM, cappedFrom: radiusKm }
    : { radiusKm }
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
  })
  return result.data
}
