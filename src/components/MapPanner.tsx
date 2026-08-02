import { useEffect } from 'react'
import { useMap } from '@vis.gl/react-google-maps'

/**
 * Pans the map to whichever place is currently selected, from either the
 * map itself or the list beside it. Rendered as a child of the map so it
 * can reach the map instance through `useMap`.
 *
 * Keyed on the raw lat/lng NUMBERS rather than the target object, and run
 * from an effect rather than during render. Both matter, and one screen
 * getting them wrong locked the map up completely:
 *
 * - Panning during render is a side effect in render. `panTo` moves the
 *   camera, the map reports the move through `onCameraChanged`, the screen
 *   stores the new centre, that re-renders, and the render pans again —
 *   a loop that pins the camera to the selected stop and makes the map
 *   impossible to drag or zoom. (It only became a live lock once the
 *   screens started storing the centre; before that the handler wrote back
 *   an identical zoom number and React bailed out of the re-render.)
 *
 * - Depending on the target OBJECT re-runs the effect whenever the caller
 *   passes a fresh `{ lat, lng }` literal — i.e. every render — which
 *   reintroduces the same loop through the effect instead of the render.
 *   Comparing the numbers means this fires when the SELECTION changes and
 *   not when the traveler simply drags the map somewhere else.
 */
export function MapPanner({ target }: { target: { lat: number; lng: number } | null }) {
  const map = useMap()
  const lat = target?.lat
  const lng = target?.lng

  useEffect(() => {
    if (!map || lat === undefined || lng === undefined) return
    map.panTo({ lat, lng })
  }, [map, lat, lng])

  return null
}
