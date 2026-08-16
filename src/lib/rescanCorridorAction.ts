import { httpsCallable } from 'firebase/functions'
import type { LatLng } from '@rv/shared'
import { functions } from './firebase'
import { SEARCH_CALLABLE_TIMEOUT_MS } from './callableTimeouts'

/** A fixed, conservative default — comfortably under the callable's own
 * MAX_RESCAN_RADIUS_KM cap. No radius picker anywhere this is used yet. */
export const RESCAN_RADIUS_KM = 25

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
