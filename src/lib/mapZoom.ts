/**
 * The zoom that fits a given span across the map.
 *
 * Requested 2026-08-25: "the default map location seems to be start point.
 * Make this gps location at like 50 km edge to edge on screen."
 *
 * Google's tiles are 256px at zoom 0 for the whole world, so the ground
 * covered by one pixel is
 *
 *     156543.03392 * cos(latitude) / 2^zoom   metres
 *
 * and the zoom that puts `spanKm` across `viewportPx` falls straight out of
 * it. The cosine matters: the same zoom covers about a third less ground in
 * northern Norway than at the Mediterranean, so a fixed number would mean
 * "50 km" only somewhere in between.
 *
 * Fractional zoom is returned deliberately — Google accepts it, and rounding
 * to whole steps doubles or halves the area, which is a poor way to honour a
 * request for 50 km.
 */
const EQUATOR_METRES_PER_PIXEL = 156_543.03392

/** Google's own limits; outside them the map silently clamps anyway. */
const MIN_ZOOM = 1
const MAX_ZOOM = 20

export function zoomForSpanKm(input: {
  spanKm: number
  /** The map element's width in CSS pixels — "edge to edge on screen". */
  viewportPx: number
  lat: number
}): number {
  const { spanKm, viewportPx, lat } = input
  if (!(spanKm > 0) || !(viewportPx > 0)) return MIN_ZOOM

  const metresPerPixel = (spanKm * 1000) / viewportPx
  const atThisLatitude =
    EQUATOR_METRES_PER_PIXEL * Math.cos((lat * Math.PI) / 180)
  const zoom = Math.log2(atThisLatitude / metresPerPixel)

  if (!Number.isFinite(zoom)) return MIN_ZOOM
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
}
