import { useEffect } from 'react'
import { useMap } from '@vis.gl/react-google-maps'
import type { LatLng } from '@rv/shared'

/**
 * Keeps every given point in frame without hand-picking a zoom — re-fits
 * whenever `points` changes, so it also doubles as "reset to an overview"
 * for a map that stays mounted across data changes it should otherwise
 * react to (e.g. Day View's Prev/Next, where the map doesn't remount just
 * because the route's `dayId` param changed).
 */
export function FitToPoints({ points }: { points: LatLng[] }) {
  const map = useMap()

  useEffect(() => {
    if (!map || points.length === 0) return
    const bounds = new google.maps.LatLngBounds()
    for (const point of points) bounds.extend(point)
    map.fitBounds(bounds, 32)
  }, [map, points])

  return null
}
