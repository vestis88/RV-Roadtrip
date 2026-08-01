import { httpsCallable } from 'firebase/functions'
import type { LatLng } from '@rv/shared'
import { functions } from './firebase'

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
): Promise<{ stopsWritten: number }> {
  const call = httpsCallable<
    {
      tripId: string
      center: LatLng
      radiusKm: number
      query?: string
      backbone?: LatLng[]
    },
    { stopsWritten: number }
  >(functions, 'rescanCorridor')
  const result = await call({
    tripId,
    center,
    radiusKm,
    ...(query ? { query } : {}),
    ...(backbone && backbone.length >= 2 ? { backbone } : {}),
  })
  return result.data
}
