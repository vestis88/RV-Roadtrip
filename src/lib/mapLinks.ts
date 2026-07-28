/**
 * A generic "navigate here" Google Maps link built from raw coordinates —
 * the fallback for anything that doesn't already have a real Places listing
 * URL (overnight stops, OSM/Claude-sourced overnight candidates). Less
 * precise than a Places URL (drops straight into a pin at the coordinate
 * rather than a named listing), but works for any lat/lng with no API call.
 */
export function googleMapsSearchUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`
}
