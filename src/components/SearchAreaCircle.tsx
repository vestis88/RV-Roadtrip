import { Circle } from '@vis.gl/react-google-maps'
import type { LatLng } from '@rv/shared'

interface SearchAreaCircleProps {
  center: LatLng
  radiusKm: number
  /**
   * Set when the visible map is wider than the search can reach, so the
   * circle is drawn at the cap rather than at the view — the one case where
   * what is searched and what is on screen genuinely differ.
   */
  capped?: boolean
}

/**
 * The area "Rescan this area" will actually search, drawn on the map.
 *
 * It was invisible, and that is the whole reason this exists. The search is a
 * circle around the map's centre, and on a wide view it could be a fraction
 * of what the traveler was looking at while the button still said "this
 * area" — reported from a map showing all of Lithuania that answered "found
 * 2 places, but they were outside the area searched". A sentence explaining
 * that is a patch; showing the circle is the fix, because then the promise
 * and the picture are the same object.
 *
 * There is no size control because the map is the size control: the circle
 * follows the viewport, so pinching to zoom resizes the search live.
 */
export function SearchAreaCircle({
  center,
  radiusKm,
  capped,
}: SearchAreaCircleProps) {
  return (
    <Circle
      center={center}
      radius={radiusKm * 1000}
      // Deliberately faint, and dashed-looking via a low opacity rather than
      // a heavy outline: this sits under every pin on the screen and must not
      // compete with them for attention. It is a boundary, not a feature.
      strokeColor="#ea580c"
      strokeOpacity={capped ? 0.9 : 0.5}
      strokeWeight={capped ? 2 : 1}
      fillColor="#ea580c"
      fillOpacity={0.06}
      clickable={false}
    />
  )
}
