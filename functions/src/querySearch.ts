import type { LatLng } from '@rv/shared'
import { searchPlacesByQuery, type QueryPlaceFind } from './placesApi.js'
import {
  filterFindsToCorridor,
  generateRescanCandidates,
  type RescanFind,
} from './prompts/rescanCorridor.js'

/**
 * How many Places hits one typed query may contribute. Places returns up to
 * 20; a search meant to add a stop or two shouldn't drop 20 unreviewed pins
 * on the map, and the ones past this are the weakest matches anyway.
 */
const MAX_QUERY_PLACES = 8

/**
 * Turns a Places hit into the "why is this here" line the corridor card
 * shows. Google gives no prose for most places, so this states what it
 * actually knows — the rating and how many people rated it — rather than
 * inventing a description. An editorial summary, where Google has one, is
 * better than either.
 */
function describePlace(place: QueryPlaceFind, query: string): string {
  const parts: string[] = []
  if (place.summary) parts.push(place.summary)
  if (place.rating != null && place.ratingCount != null) {
    parts.push(`Rated ${place.rating}/5 from ${place.ratingCount} Google reviews.`)
  }
  if (parts.length === 0) parts.push(`Found on Google Maps.`)
  parts.push(`Matched your search: "${query}".`)
  return parts.join(' ')
}

/**
 * Answers "Describe it" searches.
 *
 * Google Places first, Claude only as a fallback. The reason is latency the
 * traveler actually felt: every typed query used to go to Claude with web
 * search, which took minutes and then failed the client's own timeout —
 * reported with a screenshot of "Could not search right now" beside Google
 * Maps showing a dozen well-rated restaurants in the same town. "A cozy
 * restaurant in Hillerød" is a Places text search, and Places answers it in
 * about a second, with coordinates already attached (so it skips the
 * per-find geocoding round-trip the Claude path needs too).
 *
 * Claude still runs when Places comes back with nothing usable — queries
 * like "somewhere with a nice view about halfway" describe a judgement
 * rather than a place, and that IS worth waiting for. A Places failure
 * (quota, outage) falls through the same way rather than failing the search
 * outright.
 *
 * Every run logs where its time actually went (`event: "query_search"`).
 * That's here because two confident explanations for the reported
 * four-minute search were both wrong — first the prompt's coordinates (the
 * query named its own town all along), then an assumption about which tools
 * a Claude chat turn had. Neither was measured. This makes the next real
 * search say for itself: which path answered, how long each leg took, and
 * how many places came back — and `claude_usage` beside it carries the
 * per-attempt duration, output tokens and web-search count, which separates
 * "web search was slow" from "the answer was long" from "it retried".
 */
export async function findStopsForQuery(input: {
  query: string
  center: LatLng
  radiusKm: number
  notesFreeText?: string
  interests?: string[]
  tripId?: string
  backbone?: LatLng[]
  centerName?: string
  waypointNames?: string[]
}): Promise<{ finds: RescanFind[]; source: 'places' | 'claude' }> {
  const startedAt = Date.now()
  let places: QueryPlaceFind[] = []
  let placesError: string | undefined
  try {
    places = await searchPlacesByQuery(input.query, input.center, input.radiusKm)
  } catch (error) {
    placesError = String(error)
    console.warn('Places query search failed — falling back to Claude', error)
  }
  const placesMs = Date.now() - startedAt

  const located: RescanFind[] = places.slice(0, MAX_QUERY_PLACES).map((place) => ({
    name: place.name,
    country: place.country,
    why: describePlace(place, input.query),
    lat: place.lat,
    lng: place.lng,
    // These came straight from Places, so the listing link is already in
    // hand — the same link the Claude path now gets from verification.
    ...(place.googleMapsUrl ? { googleMapsUrl: place.googleMapsUrl } : {}),
  }))
  const withinCorridor = filterFindsToCorridor(located, input)

  if (withinCorridor.length > 0) {
    logQuerySearch({
      tripId: input.tripId,
      source: 'places',
      placesMs,
      totalMs: Date.now() - startedAt,
      placesReturned: places.length,
      finds: withinCorridor.length,
      placesError,
    })
    return { finds: withinCorridor, source: 'places' }
  }

  // Nothing from Places inside the corridor — either the query wasn't about
  // a findable place, or everything it found is too far off the route.
  // Claude gets a shot at it either way; it can reason about "along the
  // way" in a way a text search can't.
  const finds = await generateRescanCandidates(input)
  logQuerySearch({
    tripId: input.tripId,
    source: 'claude',
    placesMs,
    totalMs: Date.now() - startedAt,
    placesReturned: places.length,
    finds: finds.length,
    placesError,
  })
  return { finds, source: 'claude' }
}

function logQuerySearch(payload: {
  tripId?: string
  source: 'places' | 'claude'
  placesMs: number
  totalMs: number
  placesReturned: number
  finds: number
  placesError?: string
}): void {
  console.log(JSON.stringify({ event: 'query_search', ...payload }))
}
