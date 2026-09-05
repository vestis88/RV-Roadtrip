import { Circle, Rectangle } from '@vis.gl/react-google-maps'
import type { LatLng, MapBounds } from '@rv/shared'

interface SearchAreaProps {
  /** The rectangle that will be searched. */
  bounds?: MapBounds
  /** The circle that will be searched, when no rectangle was resolved. */
  center: LatLng
  radiusKm: number
  /**
   * Set when the visible map is wider than the search can reach, so the area
   * is drawn at the cap rather than at the view — the one case where what is
   * searched and what is on screen genuinely differ.
   */
  capped?: boolean
}

/**
 * The area "Rescan this area" will actually search, drawn on the map.
 *
 * It was invisible, and that is the whole reason this exists. On a wide view
 * the search could be a fraction of what the traveler was looking at while
 * the button still said "this area" — reported from a map showing all of
 * Lithuania that answered "found 2 places, but they were outside the area
 * searched". A sentence explaining that is a patch; showing the area is the
 * fix, because then the promise and the picture are the same object.
 *
 * A RECTANGLE since 2026-09-05, on *"Don't lock yourself to a circle if a
 * rectangle would work better"*. The circle was never a decision — it was
 * what survived measuring the viewport and keeping one number — and it cost
 * the corners of every screen: on a landscape iPad the circle covered the
 * top and bottom of the view and neither side, while the panel above it said
 * "what I can see". Now the shape drawn here, the shape Google restricts its
 * search to, and the shape a find is measured against are one rectangle.
 *
 * The circle survives only as the fallback for a view the map has not
 * reported bounds for yet, which in practice is the first frame.
 *
 * There is no size control because the map is the size control: the area
 * follows the viewport, so pinching to zoom resizes the search live.
 */
export function SearchArea({ bounds, center, radiusKm, capped }: SearchAreaProps) {
  // Deliberately faint, and dashed-looking via a low opacity rather than a
  // heavy outline: this sits under every pin on the screen and must not
  // compete with them for attention. It is a boundary, not a feature.
  const paint = {
    strokeColor: '#ea580c',
    strokeOpacity: capped ? 0.9 : 0.5,
    strokeWeight: capped ? 2 : 1,
    fillColor: '#ea580c',
    fillOpacity: 0.06,
    clickable: false,
  }
  return bounds ? (
    <Rectangle bounds={bounds} {...paint} />
  ) : (
    <Circle center={center} radius={radiusKm * 1000} {...paint} />
  )
}
