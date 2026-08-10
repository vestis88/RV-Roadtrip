import { defineSecret } from 'firebase-functions/params'
import { haversineDistanceKm } from '@rv/shared'
import type {
  Activity,
  ActivityCategory,
  LatLng,
  Meal,
  OvernightStopCandidate,
  Restaurant,
} from '@rv/shared'

export const googlePlacesApiKey = defineSecret('GOOGLE_PLACES_API_KEY')

const MIN_RATING = 3.8
const MIN_RATING_COUNT = 50
const SEARCH_RADIUS_METERS = 30_000
const ACTIVITIES_PER_DAY = 5
const RESTAURANTS_PER_MEAL = 3
const MAX_BACKFILL_ATTEMPTS = 8
// Dismiss-and-requeue (implemented 2026-07-30): a couple of extra
// activities/restaurants resolved at generation time, alongside the
// displayed count, and stored with reserve: true (see activitySchema's own
// comment) — an instant, no-round-trip swap-in when a traveler skips a
// displayed item, rather than either a gap or a live Places call on every
// dismiss.
const RESERVE_ACTIVITY_COUNT = 2
const RESERVE_RESTAURANTS_PER_MEAL = 1
// Once both the displayed items AND their reserve are exhausted for a given
// day/meal, researchMoreAlternativesCallable.ts tops the pool back up by
// this many — see that file for the full flow.
export const RESEARCH_BATCH_SIZE = 3

// Places API (New) rejects 'point_of_interest'/'establishment' as an
// includedTypes value for searchNearby (they're Text-Search-only generic
// types) — 'other' maps to undefined so nearbySearch omits the type filter
// entirely instead of sending an invalid value and getting a 400.
const ACTIVITY_PLACE_TYPE: Record<ActivityCategory, string | undefined> = {
  sight: 'tourist_attraction',
  hike: 'hiking_area',
  museum: 'museum',
  beach: 'beach',
  playground: 'playground',
  other: undefined,
}

const MEAL_PLACE_TYPE: Record<Meal, string> = {
  breakfast: 'cafe',
  lunch: 'restaurant',
  dinner: 'restaurant',
}

interface PlaceCandidate {
  id: string
  name: string
  lat: number
  lng: number
  rating?: number
  ratingCount?: number
  googleMapsUrl?: string
  photoUrl?: string
  openingHours?: string[]
  priceLevel?: number
}

interface RawPlace {
  id: string
  displayName?: { text?: string }
  location?: { latitude?: number; longitude?: number }
  rating?: number
  userRatingCount?: number
  googleMapsUri?: string
  photos?: { name: string }[]
  regularOpeningHours?: { weekdayDescriptions?: string[] }
  priceLevel?: string
}

interface PlacesSearchResponse {
  places?: RawPlace[]
}

const PRICE_LEVEL_MAP: Record<string, number> = {
  PRICE_LEVEL_FREE: 0,
  PRICE_LEVEL_INEXPENSIVE: 1,
  PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3,
  PRICE_LEVEL_VERY_EXPENSIVE: 4,
}

function mapRawPlace(raw: RawPlace, apiKey: string): PlaceCandidate {
  return {
    id: raw.id,
    name: raw.displayName?.text ?? '',
    lat: raw.location?.latitude ?? 0,
    lng: raw.location?.longitude ?? 0,
    rating: raw.rating,
    ratingCount: raw.userRatingCount,
    googleMapsUrl: raw.googleMapsUri,
    photoUrl: raw.photos?.[0]
      ? `https://places.googleapis.com/v1/${raw.photos[0].name}/media?key=${apiKey}&maxWidthPx=400`
      : undefined,
    openingHours: raw.regularOpeningHours?.weekdayDescriptions,
    priceLevel: raw.priceLevel ? PRICE_LEVEL_MAP[raw.priceLevel] : undefined,
  }
}

function meetsQualityBar(candidate: PlaceCandidate): boolean {
  return (
    (candidate.rating ?? 0) >= MIN_RATING &&
    (candidate.ratingCount ?? 0) >= MIN_RATING_COUNT
  )
}

/**
 * How far from the day's anchor a text-search result is still allowed to be.
 *
 * Places' `locationBias` (what textSearch sends) is a *preference*, not a
 * bound — with nothing matching nearby it will happily answer with the best
 * match on another continent, and nothing downstream was checking. That is
 * how a dinner stop for a night in Helsingør ended up being a hotel in
 * Greece: Claude proposed a name, no such place existed in Denmark, and a
 * well-rated Greek namesake cleared the quality bar unopposed.
 *
 * Same figure as the bias radius, now enforced rather than merely requested.
 */
const MAX_MATCH_DISTANCE_KM = SEARCH_RADIUS_METERS / 1000

/** Words that carry no identifying signal when comparing two place names. */
const NAME_STOPWORDS = new Set([
  'the', 'a', 'an', 'de', 'den', 'det', 'der', 'die', 'das', 'la', 'le', 'les',
  'el', 'il', 'restaurant', 'restaurang', 'cafe', 'café', 'kafe', 'bar',
  'hotel', 'hotell', 'museum', 'museet', 'park', 'parken', 'and', 'og', 'och',
  'und', 'et', 'y', 'i', 'in', 'at', 'of', 'på',
])

/**
 * Tokenises a place name for comparison: case-folded, diacritics stripped
 * (so "Møns" and "Mons" agree), punctuation dropped, and the generic nouns
 * above removed — "Restaurant Sletten" and "Sletten" are the same place, and
 * matching on the word "restaurant" would let any restaurant satisfy any
 * other.
 */
function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    // Letters that NFD does NOT decompose, because they are letters in their
    // own right rather than a base plus an accent. Unhandled, the strip below
    // deletes them outright and "M\u00f8ns Klint" tokenises to ["ns", "klint"] \u2014
    // which then fails to match Places' own "Mons Klint". Very much not an
    // edge case for a trip planner whose corridor is Scandinavia.
    .replace(/\u00f8/g, 'o')
    .replace(/\u00e6/g, 'ae')
    .replace(/\u00f0/g, 'd')
    .replace(/\u00fe/g, 'th')
    .replace(/\u00df/g, 'ss')
    .replace(/\u0142/g, 'l')
    .replace(/\u0111/g, 'd')
    // Everything else (\u00e5, \u00e4, \u00f6, \u00e9, \u00fc, \u2026) is a base letter plus a combining
    // mark once decomposed, so dropping the marks leaves the letter behind.
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((token) => token.length > 1 && !NAME_STOPWORDS.has(token))
}

/**
 * Whether a Places result is plausibly the place that was asked for.
 *
 * Distance alone does not catch every wrong match, because the worst ones are
 * local: asked for a small café near Berlin, Places returned "Designer Outlet
 * Berlin" — 30,000 ratings, comfortably inside the radius, and nothing like
 * what was requested. The quality bar actively causes this, since it prefers
 * exactly the famous places that outrank the modest one that was meant.
 *
 * Half of the requested name's identifying words must appear in the result's,
 * with a floor of one — forgiving enough that Places' fuller listing name
 * ("Kronborg Castle" for "Kronborg") still matches, strict enough that an
 * unrelated landmark does not. Requesting nothing identifiable (a bare
 * category, as the backfill paths do) skips the check rather than failing it:
 * those callers are asking for "a good museum near here", where any museum is
 * a correct answer.
 */
function nameLooksRight(expectedName: string | undefined, actual: string): boolean {
  if (!expectedName) return true
  const expected = nameTokens(expectedName)
  if (expected.length === 0) return true
  const found = new Set(nameTokens(actual))
  const hits = expected.filter((token) => found.has(token)).length
  return hits >= Math.max(1, Math.ceil(expected.length / 2))
}

/**
 * The single gate every text-search result must pass before it is accepted as
 * the place a plan asked for. Nearby-search results skip the distance and
 * name checks by construction: that path uses `locationRestriction` (a real
 * bound) and asks by category rather than by name.
 */
function isUsableMatch(
  candidate: PlaceCandidate,
  near: LatLng,
  expectedName: string | undefined,
  excludeIds: Set<string>,
): boolean {
  return (
    meetsQualityBar(candidate) &&
    !excludeIds.has(candidate.id) &&
    haversineDistanceKm(near, { lat: candidate.lat, lng: candidate.lng }) <=
      MAX_MATCH_DISTANCE_KM &&
    nameLooksRight(expectedName, candidate.name)
  )
}

/**
 * Exported for unit tests only. The matching gate is pure string/geometry
 * work with no network in it, which is exactly the part worth testing
 * directly — the wrong-place bugs it exists to stop were reported from
 * production, where reproducing them means a real Places round trip.
 */
export const __testing = { nameTokens, nameLooksRight }

const FIELD_MASK =
  'places.id,places.displayName,places.location,places.rating,places.userRatingCount,places.googleMapsUri,places.photos,places.regularOpeningHours.weekdayDescriptions,places.priceLevel'

async function textSearch(
  query: string,
  near: LatLng,
  apiKey: string,
): Promise<PlaceCandidate[]> {
  const response = await fetch(
    'https://places.googleapis.com/v1/places:searchText',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify({
        textQuery: query,
        locationBias: {
          circle: {
            center: { latitude: near.lat, longitude: near.lng },
            radius: SEARCH_RADIUS_METERS,
          },
        },
      }),
    },
  )
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(
      `Places text search failed with ${response.status}: ${body.slice(0, 500)}`,
    )
  }
  const data = (await response.json()) as PlacesSearchResponse
  return (data.places ?? []).map((place) => mapRawPlace(place, apiKey))
}

async function nearbySearch(
  includedType: string | undefined,
  near: LatLng,
  apiKey: string,
): Promise<PlaceCandidate[]> {
  const response = await fetch(
    'https://places.googleapis.com/v1/places:searchNearby',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify({
        ...(includedType ? { includedTypes: [includedType] } : {}),
        maxResultCount: 10,
        locationRestriction: {
          circle: {
            center: { latitude: near.lat, longitude: near.lng },
            radius: SEARCH_RADIUS_METERS,
          },
        },
      }),
    },
  )
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(
      `Places nearby search failed with ${response.status}: ${body.slice(0, 500)}`,
    )
  }
  const data = (await response.json()) as PlacesSearchResponse
  return (data.places ?? []).map((place) => mapRawPlace(place, apiKey))
}

async function resolveOne(
  query: string,
  fallbackType: string | undefined,
  near: LatLng,
  excludeIds: Set<string>,
  apiKey: string,
  expectedName?: string,
): Promise<PlaceCandidate | null> {
  const textResults = await textSearch(query, near, apiKey)
  let match = textResults.find((candidate) =>
    isUsableMatch(candidate, near, expectedName, excludeIds),
  )

  if (!match) {
    const nearbyResults = await nearbySearch(fallbackType, near, apiKey)
    match = nearbyResults.find(
      (candidate) => meetsQualityBar(candidate) && !excludeIds.has(candidate.id),
    )
  }

  if (!match) return null
  excludeIds.add(match.id)
  return match
}

/**
 * Same per-item resolution as resolveOne (text search first, nearby-search
 * fallback second, first not-yet-excluded quality match wins), but resolves
 * a whole batch of items at once. The text search — always run for every
 * item — fires for the whole batch in parallel instead of one round trip
 * per item; only the (typically rare) nearby-search fallback stays
 * sequential, since which items still need it, and which ids are already
 * taken, both depend on how earlier items in the batch resolved. Picking is
 * still done strictly in `items` order so the resulting excludeIds
 * mutations — and thus which item "wins" a contested place — match
 * resolveOne's own one-at-a-time behavior exactly, just with the network
 * calls overlapped.
 */
async function resolveBatch(
  items: {
    query: string
    fallbackType: string | undefined
    /**
     * The place name this item actually asked for, when it asked for one.
     * `query` carries the town too, so it cannot be compared against a
     * result's name directly.
     */
    expectedName?: string
  }[],
  near: LatLng,
  excludeIds: Set<string>,
  apiKey: string,
): Promise<(PlaceCandidate | null)[]> {
  const textResultsByIndex = await Promise.all(
    items.map((item) => textSearch(item.query, near, apiKey)),
  )

  const picks: (PlaceCandidate | null)[] = new Array(items.length).fill(null)
  for (let i = 0; i < items.length; i++) {
    const match = textResultsByIndex[i].find((candidate) =>
      isUsableMatch(candidate, near, items[i].expectedName, excludeIds),
    )
    if (match) {
      excludeIds.add(match.id)
      picks[i] = match
    }
  }

  for (let i = 0; i < items.length; i++) {
    if (picks[i]) continue
    const nearbyResults = await nearbySearch(items[i].fallbackType, near, apiKey)
    const match = nearbyResults.find(
      (candidate) => meetsQualityBar(candidate) && !excludeIds.has(candidate.id),
    )
    if (match) {
      excludeIds.add(match.id)
      picks[i] = match
    }
  }

  return picks
}

export interface QueryPlaceFind {
  name: string
  lat: number
  lng: number
  /** ISO 3166-1 alpha-2, from the place's own address components. */
  country: string
  rating?: number
  ratingCount?: number
  summary?: string
}

const QUERY_SEARCH_FIELD_MASK =
  'places.displayName,places.location,places.rating,places.userRatingCount,places.addressComponents,places.editorialSummary,places.formattedAddress'

/** Places' own bias radius cap. */
const MAX_BIAS_RADIUS_METERS = 50_000

function countryFromAddressComponents(
  components: { shortText?: string; types?: string[] }[] | undefined,
): string | undefined {
  const country = components?.find((component) =>
    component.types?.includes('country'),
  )?.shortText
  return country && country.length === 2 ? country.toUpperCase() : undefined
}

/**
 * Answers a traveler's typed description ("a cozy restaurant in Hillerød")
 * straight from Google Places, in one request.
 *
 * This exists because the "Describe it" search used to go to Claude with
 * web search for every query, which took minutes and then timed out on
 * exactly the questions Google answers instantly — reported with a
 * screenshot of the app's own failure next to Google Maps showing a dozen
 * well-rated restaurants in the same town. Anything phrased as "a <kind of
 * place> in/near <somewhere>" is a Places text search; Claude is worth its
 * latency only for the questions Places genuinely can't answer.
 *
 * Returns coordinates directly, so unlike the Claude path these finds need
 * no separate geocoding round-trip. Places whose country can't be
 * determined are dropped rather than guessed — corridorStopSchema requires
 * a real 2-letter code, and the wrong one lands the stop in the wrong
 * country's guide.
 */
export async function searchPlacesByQuery(
  query: string,
  near: LatLng,
  biasRadiusKm: number,
): Promise<QueryPlaceFind[]> {
  const apiKey = googlePlacesApiKey.value()
  if (!apiKey) {
    throw new Error(
      'GOOGLE_PLACES_API_KEY is not configured — place search requires real data and has no synthetic fallback.',
    )
  }
  const response = await fetch(
    'https://places.googleapis.com/v1/places:searchText',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': QUERY_SEARCH_FIELD_MASK,
      },
      body: JSON.stringify({
        textQuery: query,
        locationBias: {
          circle: {
            center: { latitude: near.lat, longitude: near.lng },
            radius: Math.min(biasRadiusKm * 1000, MAX_BIAS_RADIUS_METERS),
          },
        },
      }),
    },
  )
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(
      `Places query search failed with ${response.status}: ${body.slice(0, 500)}`,
    )
  }
  const data = (await response.json()) as {
    places?: {
      displayName?: { text?: string }
      location?: { latitude: number; longitude: number }
      rating?: number
      userRatingCount?: number
      addressComponents?: { shortText?: string; types?: string[] }[]
      editorialSummary?: { text?: string }
      formattedAddress?: string
    }[]
  }
  return (data.places ?? []).flatMap((place) => {
    const name = place.displayName?.text
    const country = countryFromAddressComponents(place.addressComponents)
    if (!name || !place.location || !country) return []
    return [
      {
        name,
        lat: place.location.latitude,
        lng: place.location.longitude,
        country,
        rating: place.rating,
        ratingCount: place.userRatingCount,
        summary: place.editorialSummary?.text ?? place.formattedAddress,
      },
    ]
  })
}

/**
 * Resolves a free-text place query (e.g. "Lillehammer Camping, Lillehammer,
 * NO") to coordinates, biased near a reference point. Unlike resolveOne,
 * this applies no quality bar — a town/campsite name isn't a "tourist
 * attraction" and may have few or no ratings; the first match is enough
 * since only its location is needed, not its quality.
 */
export async function geocodeQuery(
  query: string,
  near: LatLng,
): Promise<LatLng | null> {
  const apiKey = googlePlacesApiKey.value()
  if (!apiKey) {
    throw new Error(
      'GOOGLE_PLACES_API_KEY is not configured — geocoding requires real data and has no synthetic fallback.',
    )
  }
  const results = await textSearch(query, near, apiKey)
  const first = results[0]
  return first ? { lat: first.lat, lng: first.lng } : null
}

export interface ProposedActivity {
  name: string
  town: string
  category: ActivityCategory
  kidFriendly: boolean
  blurb: string
}

/**
 * Resolves `count` generic activities via Places, rotating through every
 * category so a single exhausted category can't stall the whole backfill.
 * Shared by enrichActivities's own backfill (filling up to the displayed
 * count) and researchMoreAlternativesCallable.ts (topping the pool back up
 * once both the displayed items and their reserve are gone) — same logic,
 * different caller, not a hand-rolled second copy.
 */
export async function backfillActivities(
  near: LatLng,
  excludeIds: Set<string>,
  apiKey: string,
  count: number,
  reserve: boolean,
): Promise<Activity[]> {
  const categories = Object.keys(ACTIVITY_PLACE_TYPE) as ActivityCategory[]
  const resolved: Activity[] = []
  for (
    let attempt = 0;
    resolved.length < count && attempt < MAX_BACKFILL_ATTEMPTS;
    attempt++
  ) {
    const category = categories[attempt % categories.length]
    const match = await resolveOne(
      category,
      ACTIVITY_PLACE_TYPE[category],
      near,
      excludeIds,
      apiKey,
    )
    if (match) {
      resolved.push({
        name: match.name,
        category,
        lat: match.lat,
        lng: match.lng,
        rating: match.rating,
        ratingCount: match.ratingCount,
        googleMapsUrl: match.googleMapsUrl,
        photoUrl: match.photoUrl,
        openingHours: match.openingHours,
        blurb: `A well-rated local ${category}.`,
        kidFriendly: false,
        status: 'suggested',
        ...(reserve ? { reserve: true } : {}),
        placeId: match.id,
      })
    }
  }
  return resolved
}

/**
 * Resolves proposed activities against Places, backfilling by category until
 * exactly `ACTIVITIES_PER_DAY` are found, then resolves `RESERVE_ACTIVITY_COUNT`
 * more on top — invisible until dismiss-and-requeue needs one (see
 * activitySchema's own comment).
 */
export async function enrichActivities(
  proposed: ProposedActivity[],
  near: LatLng,
): Promise<Activity[]> {
  const apiKey = googlePlacesApiKey.value()
  if (!apiKey) {
    throw new Error(
      'GOOGLE_PLACES_API_KEY is not configured — Places enrichment requires real data and has no synthetic fallback.',
    )
  }

  const excludeIds = new Set<string>()
  const resolved: Activity[] = []

  const matches = await resolveBatch(
    proposed.map((item) => ({
      query: `${item.name}, ${item.town}`,
      // What was actually asked for, so a famous unrelated landmark cannot
      // answer for a small named place — see nameLooksRight.
      expectedName: item.name,
      fallbackType: ACTIVITY_PLACE_TYPE[item.category],
    })),
    near,
    excludeIds,
    apiKey,
  )
  for (let i = 0; i < proposed.length; i++) {
    const match = matches[i]
    const item = proposed[i]
    if (match) {
      resolved.push({
        name: match.name,
        category: item.category,
        lat: match.lat,
        lng: match.lng,
        rating: match.rating,
        ratingCount: match.ratingCount,
        googleMapsUrl: match.googleMapsUrl,
        photoUrl: match.photoUrl,
        openingHours: match.openingHours,
        blurb: item.blurb,
        kidFriendly: item.kidFriendly,
        status: 'suggested',
        placeId: match.id,
      })
    }
  }

  resolved.push(
    ...(await backfillActivities(
      near,
      excludeIds,
      apiKey,
      ACTIVITIES_PER_DAY - resolved.length,
      false,
    )),
  )
  const primary = resolved.slice(0, ACTIVITIES_PER_DAY)
  const reserve = await backfillActivities(
    near,
    excludeIds,
    apiKey,
    RESERVE_ACTIVITY_COUNT,
    true,
  )
  return [...primary, ...reserve]
}

export interface ProposedRestaurant {
  name: string
  town: string
  meal: Meal
  cuisine?: string
  blurb: string
}

/**
 * Resolves `count` generic restaurants for one meal via Places. Shared by
 * enrichRestaurantsForMeal's own backfill and researchMoreAlternativesCallable.ts
 * — see backfillActivities's own comment for why this isn't duplicated.
 */
export async function backfillRestaurantsForMeal(
  meal: Meal,
  near: LatLng,
  excludeIds: Set<string>,
  apiKey: string,
  count: number,
  reserve: boolean,
): Promise<Restaurant[]> {
  const resolved: Restaurant[] = []
  for (
    let attempt = 0;
    resolved.length < count && attempt < MAX_BACKFILL_ATTEMPTS;
    attempt++
  ) {
    const match = await resolveOne(
      MEAL_PLACE_TYPE[meal],
      MEAL_PLACE_TYPE[meal],
      near,
      excludeIds,
      apiKey,
    )
    if (match) {
      resolved.push({
        name: match.name,
        meal,
        lat: match.lat,
        lng: match.lng,
        rating: match.rating,
        ratingCount: match.ratingCount,
        googleMapsUrl: match.googleMapsUrl,
        photoUrl: match.photoUrl,
        priceLevel: match.priceLevel,
        blurb: `A well-rated spot for ${meal}.`,
        status: 'suggested',
        ...(reserve ? { reserve: true } : {}),
        placeId: match.id,
      })
    }
  }
  return resolved
}

/**
 * Resolves proposed restaurants for one meal, backfilling until exactly
 * `RESTAURANTS_PER_MEAL` are found, then resolves
 * `RESERVE_RESTAURANTS_PER_MEAL` more on top — same reserve mechanism as
 * enrichActivities.
 */
export async function enrichRestaurantsForMeal(
  proposed: ProposedRestaurant[],
  meal: Meal,
  near: LatLng,
  excludeIds: Set<string>,
): Promise<Restaurant[]> {
  const apiKey = googlePlacesApiKey.value()
  if (!apiKey) {
    throw new Error(
      'GOOGLE_PLACES_API_KEY is not configured — Places enrichment requires real data and has no synthetic fallback.',
    )
  }

  const resolved: Restaurant[] = []

  const matches = await resolveBatch(
    proposed.map((item) => ({
      query: `${item.name}, ${item.town}`,
      // What was actually asked for, so a famous unrelated landmark cannot
      // answer for a small named place — see nameLooksRight.
      expectedName: item.name,
      fallbackType: MEAL_PLACE_TYPE[meal],
    })),
    near,
    excludeIds,
    apiKey,
  )
  for (let i = 0; i < proposed.length; i++) {
    const match = matches[i]
    const item = proposed[i]
    if (match) {
      resolved.push({
        name: match.name,
        meal,
        lat: match.lat,
        lng: match.lng,
        rating: match.rating,
        ratingCount: match.ratingCount,
        googleMapsUrl: match.googleMapsUrl,
        photoUrl: match.photoUrl,
        priceLevel: match.priceLevel,
        cuisine: item.cuisine,
        blurb: item.blurb,
        status: 'suggested',
        placeId: match.id,
      })
    }
  }

  resolved.push(
    ...(await backfillRestaurantsForMeal(
      meal,
      near,
      excludeIds,
      apiKey,
      RESTAURANTS_PER_MEAL - resolved.length,
      false,
    )),
  )
  const primary = resolved.slice(0, RESTAURANTS_PER_MEAL)
  const reserve = await backfillRestaurantsForMeal(
    meal,
    near,
    excludeIds,
    apiKey,
    RESERVE_RESTAURANTS_PER_MEAL,
    true,
  )
  return [...primary, ...reserve]
}

/**
 * Overnight-stop candidates, commercial-campsite type (implemented
 * 2026-07-27): unlike activities/restaurants, `rv_park` and `campground`
 * are both valid Places (New) includedTypes — rv_park specifically excludes
 * tent-only sites, the right match for an RV, so it's searched first and
 * campground fills in the rest. Same quality bar as activities/restaurants.
 */
export async function searchCampsiteCandidates(
  near: LatLng,
  country: string,
  limit: number,
): Promise<OvernightStopCandidate[]> {
  const apiKey = googlePlacesApiKey.value()
  if (!apiKey) {
    throw new Error(
      'GOOGLE_PLACES_API_KEY is not configured — campsite lookup requires real data and has no synthetic fallback.',
    )
  }

  const seenIds = new Set<string>()
  const candidates: OvernightStopCandidate[] = []
  for (const placeType of ['rv_park', 'campground']) {
    if (candidates.length >= limit) break
    const results = await nearbySearch(placeType, near, apiKey)
    for (const result of results) {
      if (candidates.length >= limit) break
      if (seenIds.has(result.id) || !meetsQualityBar(result)) continue
      seenIds.add(result.id)
      candidates.push({
        name: result.name,
        type: 'campsite',
        lat: result.lat,
        lng: result.lng,
        country,
        description: result.rating
          ? `Rated ${result.rating.toFixed(1)} (${result.ratingCount ?? 0} reviews) on Google.`
          : 'Commercial campsite.',
        source: 'places',
        ...(result.googleMapsUrl ? { googleMapsUrl: result.googleMapsUrl } : {}),
      })
    }
  }
  return candidates
}
