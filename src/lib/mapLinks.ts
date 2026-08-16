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

/**
 * The same link, asked for by name instead — what a person would type.
 *
 * Google resolves this to the listing, with its photos, reviews and opening
 * hours; a coordinate resolves to a dropped pin with none of them. The place
 * context (town, country) is what keeps a common name from matching a
 * namesake in another country, so it is required rather than optional.
 */
export function googleMapsNameUrl(name: string, context: string): string {
  const query = [name, context].filter(Boolean).join(', ')
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`
}

/**
 * The best link available for a place the traveler wants to READ about —
 * "Photos & details" on a candidate card.
 *
 * Reported with a screenshot: tapping it opened 59°31'53.6"N 12°44'40.7"E, a
 * nameless pin in a field, rather than Klässbols Linneväveri. Everything the
 * link is for — the photos, the reviews, the opening hours, even confirming
 * it is the right building — lives on the listing, and a coordinate reaches
 * none of it.
 *
 * `googleMapsUrl` is Google's own URL for the exact listing and is always
 * right when present, but only stops curated since it started being stored
 * have one. The name query is what rescues the stops already in Firestore:
 * their names came from Places in the first place (verifyPlaceLocation
 * returns Places' own spelling), so they resolve. Coordinates remain the
 * last resort, for a stop with no usable name at all.
 */
export function placeDetailsUrl(place: {
  googleMapsUrl?: string
  name?: string
  lat: number
  lng: number
  baseTown?: string
  country?: string
}): string {
  if (place.googleMapsUrl) return place.googleMapsUrl
  if (place.name) {
    const context = [place.baseTown, place.country].filter(Boolean).join(', ')
    return googleMapsNameUrl(place.name, context)
  }
  return googleMapsSearchUrl(place.lat, place.lng)
}

/**
 * The best link available for a place the traveler has to ARRIVE at — an
 * overnight stop.
 *
 * Deliberately NOT placeDetailsUrl: a name query is an improvement when the
 * question is "show me this place" and a hazard when the question is "take me
 * to this exact point". A stellplatz or a free spot IS a coordinate — a
 * mapped lay-by, whose `name` is the town it is near rather than a business
 * Google could look up — and resolving that name would route the RV to the
 * town square at dusk instead of to the pull-in. So: the real listing when
 * the night is a Places-sourced campsite, and otherwise the coordinate,
 * which is not a degraded answer here but the correct one.
 */
export function navigateUrl(stop: {
  googleMapsUrl?: string
  lat: number
  lng: number
}): string {
  return stop.googleMapsUrl ?? googleMapsSearchUrl(stop.lat, stop.lng)
}
