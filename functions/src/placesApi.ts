import { defineSecret } from 'firebase-functions/params'
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
): Promise<PlaceCandidate | null> {
  const textResults = await textSearch(query, near, apiKey)
  let match = textResults.find(
    (candidate) => meetsQualityBar(candidate) && !excludeIds.has(candidate.id),
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
  items: { query: string; fallbackType: string | undefined }[],
  near: LatLng,
  excludeIds: Set<string>,
  apiKey: string,
): Promise<(PlaceCandidate | null)[]> {
  const textResultsByIndex = await Promise.all(
    items.map((item) => textSearch(item.query, near, apiKey)),
  )

  const picks: (PlaceCandidate | null)[] = new Array(items.length).fill(null)
  for (let i = 0; i < items.length; i++) {
    const match = textResultsByIndex[i].find(
      (candidate) => meetsQualityBar(candidate) && !excludeIds.has(candidate.id),
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
