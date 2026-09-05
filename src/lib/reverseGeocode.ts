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

/**
 * The two-letter country a point sits in.
 *
 * Reported 2026-08-31 as a day list that would not respond to rebuilds and
 * days that could not be opened. The cause was upstream of both:
 * `planSkeleton` drops any stop whose `country` is not exactly two letters,
 * because `overnightStopSchema` requires one — and a stop pinned by hand
 * never had a country written at all. So every hand-added stop was invisible
 * to the packer forever: it could never be given a day, the "these days are
 * from an earlier plan" banner counted it forever, and the rebuild it
 * offered could not possibly help.
 *
 * Resolved here for the same reason the name above is: the Maps JS API is
 * already loaded for the map itself, so this costs no new key. Undefined on
 * failure, and the caller simply leaves the stop as it was.
 */
export async function reverseGeocodeCountry(
  point: { lat: number; lng: number },
): Promise<string | undefined> {
  return Promise.race([resolveCountry(point), timeout(NAME_LOOKUP_TIMEOUT_MS)])
}

async function resolveCountry(
  point: { lat: number; lng: number },
): Promise<string | undefined> {
  try {
    const { Geocoder } = (await google.maps.importLibrary(
      'geocoding',
    )) as google.maps.GeocodingLibrary
    const { results } = await new Geocoder().geocode({ location: point })
    for (const result of results) {
      const country = result.address_components.find((part) =>
        part.types.includes('country'),
      )?.short_name
      // Exactly two letters, because that is what the schema accepts and a
      // longer "country" here would fail the same way a missing one does.
      if (country && country.length === 2) return country.toUpperCase()
    }
    return undefined
  } catch (error) {
    console.warn('Reverse geocoding a country failed', error)
    return undefined
  }
}

export async function reverseGeocodeName(
  point: { lat: number; lng: number },
): Promise<string | undefined> {
  return Promise.race([resolveName(point), timeout(NAME_LOOKUP_TIMEOUT_MS)])
}

async function resolveName(
  point: { lat: number; lng: number },
): Promise<string | undefined> {
  const results = await geocodeResults(point)
  if (results.length === 0) return undefined
  return (mostSpecific(results) ?? results[0]).formatted_address
}

/** The raw ladder for a point, or an empty list. Never throws. */
async function geocodeResults(point: {
  lat: number
  lng: number
}): Promise<google.maps.GeocoderResult[]> {
  try {
    const { Geocoder } = (await google.maps.importLibrary(
      'geocoding',
    )) as google.maps.GeocodingLibrary
    const { results } = await new Geocoder().geocode({ location: point })
    return results
  } catch (error) {
    // A point in the sea geocodes to nothing, which is not a failure — it is
    // a fact about that corner of the map.
    console.warn('Reverse geocoding a point failed', error)
    return []
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

/**
 * What the visible rectangle IS, in the terms a person would use.
 *
 * Asked for on 2026-09-05, after the Places sweep was extended to cover a
 * wide area: *"I would expect you to come up with a way to define the area
 * of interest to Claude in a reasonable way. I don't want google places to
 * cloud Claude's own thinking here!"*
 *
 * That is the right line, and it is the line between two different Google
 * services. **Places** enumerates businesses and landmarks, ranked by review
 * count — hand a model forty of those across a region and you have handed it
 * the answer, ranked by popularity, which is precisely what this feature
 * exists not to be. **The geocoder** answers a different question: what is
 * this piece of the world called. Regions, provinces, towns, coastline. That
 * is geography, not a shortlist, and it is what a model needs before it can
 * think about a place at all.
 *
 * So the search is told where it is looking the way you would tell a person:
 * the middle, the four corners, how far across, and which regions it spans.
 * What is worth stopping for inside that is left entirely to Claude, which
 * is the only part of this it is uniquely good at.
 *
 * Nine points in a 3×3 grid, all looked up at once. Corners state the span;
 * the whole grid catches regions a corner would miss — a 250 km rectangle
 * over central Italy touches Lazio, Abruzzo, Umbria, Marche and Molise, and
 * four corners find perhaps three of them. Each point may fail on its own:
 * out at sea there is nothing to name, and three named corners describe an
 * area far better than none do.
 */
export interface SearchAreaDescription {
  /** The most specific name for the middle — the old `centerName`. */
  centerName?: string
  corners: {
    northWest?: string
    northEast?: string
    southWest?: string
    southEast?: string
  }
  /** Distinct administrative regions the rectangle covers. */
  regions: string[]
  /** And the countries, since a wide view crosses borders. */
  countries: string[]
}

export async function describeSearchArea(bounds: {
  north: number
  south: number
  east: number
  west: number
}): Promise<SearchAreaDescription> {
  const lats = [bounds.north, (bounds.north + bounds.south) / 2, bounds.south]
  const lngs = [bounds.west, (bounds.west + bounds.east) / 2, bounds.east]
  const grid = lats.flatMap((lat, row) =>
    lngs.map((lng, column) => ({ lat, lng, row, column })),
  )

  const sampled = await Promise.all(
    grid.map(async (point) => ({
      ...point,
      results: await Promise.race([
        geocodeResults(point),
        timeout(NAME_LOOKUP_TIMEOUT_MS).then(
          () => [] as google.maps.GeocoderResult[],
        ),
      ]),
    })),
  )

  const at = (row: number, column: number) =>
    sampled.find((point) => point.row === row && point.column === column)
  const nameAt = (row: number, column: number): string | undefined => {
    const results = at(row, column)?.results ?? []
    if (results.length === 0) return undefined
    return (mostSpecific(results) ?? results[0]).formatted_address
  }

  const regions: string[] = []
  const countries: string[] = []
  for (const point of sampled) {
    for (const result of point.results) {
      for (const part of result.address_components) {
        if (
          part.types.includes('administrative_area_level_1') &&
          !regions.includes(part.long_name)
        ) {
          regions.push(part.long_name)
        }
        if (
          part.types.includes('country') &&
          !countries.includes(part.long_name)
        ) {
          countries.push(part.long_name)
        }
      }
    }
  }

  return {
    ...(nameAt(1, 1) ? { centerName: nameAt(1, 1) } : {}),
    corners: {
      ...(nameAt(0, 0) ? { northWest: nameAt(0, 0) } : {}),
      ...(nameAt(0, 2) ? { northEast: nameAt(0, 2) } : {}),
      ...(nameAt(2, 0) ? { southWest: nameAt(2, 0) } : {}),
      ...(nameAt(2, 2) ? { southEast: nameAt(2, 2) } : {}),
    },
    regions,
    countries,
  }
}
