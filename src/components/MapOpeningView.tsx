import { useEffect, useRef } from 'react'
import { useMap } from '@vis.gl/react-google-maps'
import { zoomForSpanKm } from '../lib/mapZoom'

/**
 * Opens the map where the traveler is, not where the trip began.
 *
 * Requested 2026-08-25: "the default map location seems to be start point.
 * Make this gps location at like 50 km edge to edge on screen." On day twelve
 * of a trip, opening on the start point means opening on a town a week and a
 * half behind you.
 *
 * ONCE, and that is the whole subtlety. A GPS watch reports a fix every few
 * seconds, and re-centring on each one would drag the map out from under
 * anyone trying to look somewhere else — the same class of fault as the
 * render-time pan that once locked this map up completely (see MapPanner).
 * So it fires on the first fix and never again, and it declines even that
 * one if the traveler has already moved the camera.
 *
 * The zoom is computed from the map element's real width rather than being a
 * constant, because "50 km edge to edge" is a different zoom on a 390px phone
 * than on a 1180px tablet, and different again at 69°N than at 41°N.
 */
export function MapOpeningView({
  position,
  spanKm,
  moved,
}: {
  position: { lat: number; lng: number } | null
  spanKm: number
  /** The traveler has already panned or zoomed — leave them alone. */
  moved: boolean
}) {
  const map = useMap()
  const done = useRef(false)
  const lat = position?.lat
  const lng = position?.lng

  useEffect(() => {
    if (done.current || moved) return
    if (!map || lat === undefined || lng === undefined) return
    done.current = true

    const width = map.getDiv()?.offsetWidth ?? 0
    map.moveCamera({
      center: { lat, lng },
      zoom: zoomForSpanKm({ spanKm, viewportPx: width, lat }),
    })
  }, [map, lat, lng, spanKm, moved])

  return null
}
