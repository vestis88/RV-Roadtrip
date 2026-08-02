/**
 * Turns the map's centre into a name a person (or a model) would recognise —
 * "Hillerød, Denmark" rather than "latitude 55.93, longitude 12.31".
 *
 * This exists because of what the search prompt was actually being told.
 * Every rescan sent Claude the centre as bare coordinates, on the reasoning
 * that giving it no geography meant it could invent none. In practice that
 * inverted the cost: asked for "a cozy restaurant in Hillerød" near
 * "latitude 55.93, longitude 12.31", the model first had to work out where
 * on earth that was — burning its whole web-search budget and minutes of
 * wall time before it could even start looking for restaurants. Asked the
 * same question with the town's name, Claude answers in about two seconds
 * (as the traveler demonstrated in Claude chat, side by side with the app
 * failing).
 *
 * Resolved on the client because the Maps JS API is already loaded here for
 * the map itself — no extra key, no extra API to enable server-side.
 * Failure is not an error: the caller passes nothing and the prompt falls
 * back to coordinates, exactly as before.
 *
 * Hard-capped in time, and that matters more than it looks: this runs
 * BEFORE the search it improves, so anything it does slowly it does to the
 * traveler. Where Maps JS is unreachable, `importLibrary` doesn't reject —
 * it waits for a script that will never arrive — so a plain try/catch is
 * not enough on its own to keep the search moving.
 */
const NAME_LOOKUP_TIMEOUT_MS = 2_500

function timeout(ms: number): Promise<undefined> {
  return new Promise((resolve) => setTimeout(() => resolve(undefined), ms))
}

export async function reverseGeocodeName(
  point: { lat: number; lng: number },
): Promise<string | undefined> {
  return Promise.race([resolveName(point), timeout(NAME_LOOKUP_TIMEOUT_MS)])
}

async function resolveName(
  point: { lat: number; lng: number },
): Promise<string | undefined> {
  try {
    const { Geocoder } = (await google.maps.importLibrary(
      'geocoding',
    )) as google.maps.GeocodingLibrary
    const { results } = await new Geocoder().geocode({ location: point })
    if (results.length === 0) return undefined

    // Prefer the smallest administrative name that still means something to
    // a reader — the town, not the street address of whatever happened to be
    // nearest the centre pixel, and not "Denmark" either.
    const preferred =
      results.find((result) => result.types.includes('locality')) ??
      results.find((result) => result.types.includes('postal_town')) ??
      results.find((result) =>
        result.types.includes('administrative_area_level_2'),
      ) ??
      results[0]
    return preferred.formatted_address
  } catch (error) {
    console.warn('Reverse geocoding the map centre failed', error)
    return undefined
  }
}
