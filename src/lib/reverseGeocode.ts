/**
 * Turns the map's centre into a name a person (or a model) would recognise —
 * "Hillerød, Denmark" rather than "latitude 55.93, longitude 12.31".
 *
 * What this is NOT: it is not why a search naming its own town ("a cozy
 * restaurant in Hillerød") used to fail. That query reached the model
 * verbatim as `focusQuery`, town and all — the traveler pointed this out
 * after an earlier version of this comment claimed otherwise. The slowness
 * there was the tool, not the geography: web-search grounding instead of a
 * place lookup (see querySearch.ts).
 *
 * What it IS for: the searches where the app supplies the geography rather
 * than the traveler. A plain "Rescan this area" says only "what's worth
 * stopping for near here", and "here" used to be a pair of decimals; the
 * corridor was up to 50 more of them, against which the prompt asks the
 * model to judge whether a find is a small detour. Names make both of those
 * answerable.
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
