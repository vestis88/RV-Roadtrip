import { defineSecret } from 'firebase-functions/params'
import type {
  Activity,
  ActivityCategory,
  LatLng,
  Meal,
  Restaurant,
} from '@rv/shared'

export const googlePlacesApiKey = defineSecret('GOOGLE_PLACES_API_KEY')

const MIN_RATING = 3.8
const MIN_RATING_COUNT = 50
const SEARCH_RADIUS_METERS = 30_000
const ACTIVITIES_PER_DAY = 5
const RESTAURANTS_PER_MEAL = 3
const MAX_BACKFILL_ATTEMPTS = 8

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

/** Resolves proposed activities against Places, backfilling by category until exactly 5 are found. */
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

  for (const item of proposed) {
    const match = await resolveOne(
      `${item.name}, ${item.town}`,
      ACTIVITY_PLACE_TYPE[item.category],
      near,
      excludeIds,
      apiKey,
    )
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
      })
    }
  }

  const categories = Object.keys(ACTIVITY_PLACE_TYPE) as ActivityCategory[]
  for (
    let attempt = 0;
    resolved.length < ACTIVITIES_PER_DAY && attempt < MAX_BACKFILL_ATTEMPTS;
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
      })
    }
  }

  return resolved.slice(0, ACTIVITIES_PER_DAY)
}

export interface ProposedRestaurant {
  name: string
  town: string
  meal: Meal
  cuisine?: string
  blurb: string
}

/** Resolves proposed restaurants for one meal, backfilling until exactly 3 are found. */
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

  for (const item of proposed) {
    const match = await resolveOne(
      `${item.name}, ${item.town}`,
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
        priceLevel: match.priceLevel,
        cuisine: item.cuisine,
        blurb: item.blurb,
        status: 'suggested',
      })
    }
  }

  for (
    let attempt = 0;
    resolved.length < RESTAURANTS_PER_MEAL && attempt < MAX_BACKFILL_ATTEMPTS;
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
        priceLevel: match.priceLevel,
        blurb: `A well-rated spot for ${meal}.`,
        status: 'suggested',
      })
    }
  }

  return resolved.slice(0, RESTAURANTS_PER_MEAL)
}
