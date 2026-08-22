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

    const preferred = mostSpecific(results) ?? results[0]
    return preferred.formatted_address
  } catch (error) {
    console.warn('Reverse geocoding the map centre failed', error)
    return undefined
  }
}

/**
 * How much use a name is as the ONLY thing telling a search where it is.
 *
 * Reported 2026-08-22 from a map centred on Plansee with a 7 km circle: four
 * finds, every one of them outside it, and the objection "It was right to
 * limit at 7 km. It was wrong to find nothing within the 7 km. There are for
 * sure things to do!" There are, and the search never had a chance to name
 * them — because the model is deliberately given no coordinates (see the
 * prompt's hard rule 2, and its own note on why), so this string is the
 * entire statement of where the circle is.
 *
 * The old ladder was locality, then postal_town, then
 * administrative_area_level_2. A point in the middle of a lake is in no
 * locality at all, so it fell to level 2 — in Austria the Bezirk — and the
 * search was told it was looking at "Reutte, Austria", a district of some
 * 1,200 km², with a radius of 7. It answered with the best of that district:
 * Ehrenberg, the highline, Reutte itself. Four real places, all correct
 * answers to the question asked, all 10 km or more from the circle they were
 * then measured against and dropped for missing.
 *
 * Nothing in the reply was wrong. The question was.
 *
 * So a named feature now outranks any administrative area: "Plansee" locates
 * a 7 km circle and "Reutte District" cannot. The original intent — not the
 * street address of whatever pixel the centre landed on, not "Austria"
 * either — survives as the ordering below rather than as a three-rung
 * ladder that skipped straight past the lake it was floating on.
 */
const NAME_PRECEDENCE = [
  // Named features and places. The centre is ON one of these, so it is the
  // most precise thing that is also recognisable.
  'natural_feature',
  'park',
  'tourist_attraction',
  'point_of_interest',
  'establishment',
  // Then settlements, smallest first.
  'locality',
  'postal_town',
  'sublocality',
  'neighborhood',
  // Then roads: precise, and dull, but they anchor a circle.
  'street_address',
  'route',
  // Administrative areas last, largest last. These are what the search can
  // do least with, because their name says nothing about their size.
  'administrative_area_level_3',
  'administrative_area_level_2',
  'administrative_area_level_1',
]

function rank(result: google.maps.GeocoderResult): number {
  // A plus code is a coordinate in disguise: it names nothing, so it is
  // never the answer even though it is usually the most "precise" result.
  if (result.types.length === 1 && result.types[0] === 'plus_code') {
    return Number.POSITIVE_INFINITY
  }
  const best = result.types
    .map((type) => NAME_PRECEDENCE.indexOf(type))
    .filter((index) => index >= 0)
  return best.length > 0 ? Math.min(...best) : Number.POSITIVE_INFINITY
}

export function mostSpecific(
  results: google.maps.GeocoderResult[],
): google.maps.GeocoderResult | undefined {
  let best: google.maps.GeocoderResult | undefined
  let bestRank = Number.POSITIVE_INFINITY
  for (const result of results) {
    const current = rank(result)
    // Strictly better, so Google's own ordering breaks ties — it returns
    // results most specific first.
    if (current < bestRank) {
      best = result
      bestRank = current
    }
  }
  return best
}
