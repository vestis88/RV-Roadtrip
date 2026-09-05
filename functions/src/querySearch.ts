import type { LatLng, MapBounds } from '@rv/shared'
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
 * Why the Claude leg could not answer — coarse on purpose.
 *
 * The fallback existed from the start and worked exactly as designed on
 * 2026-08-28: Claude 400'd in half a second, Places answered, and eight
 * stops appeared on the map. What it did NOT do was say so, and the report
 * that followed was *"The results seem to be based solely on Google Maps
 * results again?"* — the traveler reading a silent, correct fallback as the
 * regression they had reported four days earlier. Reading production logs
 * was the only way to tell the two apart, which is a diagnosis a traveler in
 * a lay-by cannot make.
 *
 * The kinds are the ones with DIFFERENT answers for the person reading them:
 * out of credit is a card to top up, a rejected key is a deployment
 * problem, a rate limit is "wait a minute", and a timeout is "try again".
 * Anything else stays "it failed" rather than being guessed at.
 */
export type ClaudeFailureKind =
  | 'credit'
  | 'auth'
  | 'rate-limit'
  | 'timeout'
  | 'other'

/**
 * Matched against the message rather than a status code because that is what
 * survives the SDK's own error wrapping — the 2026-08-28 entry reached the
 * log as a string containing both the 400 and the sentence about credit.
 */
export function classifyClaudeFailure(error: string): ClaudeFailureKind {
  const text = error.toLowerCase()
  if (text.includes('credit balance') || text.includes('billing')) return 'credit'
  if (
    text.includes('authentication') ||
    text.includes('invalid x-api-key') ||
    text.includes('401')
  ) {
    return 'auth'
  }
  if (text.includes('rate limit') || text.includes('429')) return 'rate-limit'
  if (text.includes('timeout') || text.includes('timed out')) return 'timeout'
  return 'other'
}

/**
 * Answers "Describe it" and preset searches.
 *
 * **Claude first, Places only as a fallback.** Inverted 2026-08-24, and the
 * report says why better than any argument here: *"Don't expect to find
 * pizza when I search all of Italy for things to do. Also, the good
 * descriptions and pictures were dropped, so the whole functionality seems
 * wrong… I'd also like the std Claude search to be default also for zoomed
 * in, and places if nothing is found."*
 *
 * Both halves of that were structural, not incidental:
 *
 *  - **The blurb.** The Places branch describes a find with `describePlace`
 *    — the place's own Google summary, its star rating, and "Matched your
 *    search: …". That is the template blurb reported on 2026-08-18 as
 *    descriptions having "become quite generic", and the planning notes for
 *    the board rework name wiring anything new to it as the trap to avoid.
 *    Claude's `why` is written for the traveler's own interests.
 *  - **The photo.** The Places branch never set `photoUrl` at all — not a
 *    lookup that sometimes missed, a field it never populated. The Claude
 *    path verifies every find through `verifyPlaceLocation`, which is where
 *    a photo and a listing link come from. So pictures were not "dropped";
 *    they were never reachable down this path.
 *
 * And a text search takes the query literally: "something worth doing nearby
 * right now" against a viewport over Tuscany returns the Tower of Pisa,
 * because that is what ranks, not because anyone weighed it against a family
 * that came for mountain biking.
 *
 * WHAT THIS COSTS, stated because it is a real trade and was the original
 * reason for the other order. Places answers in about a second; Claude takes
 * seconds and a token spend. The latency that drove the first design was a
 * Claude path running WEB SEARCH, which took minutes and blew the client's
 * own timeout — that tool was removed in August, and what remains is one
 * tool-free turn plus per-find verification. Slower than Places, nowhere
 * near the failure that set this order.
 *
 * Places still catches everything Claude cannot answer: an outage, a missing
 * key, a timeout, or simply a turn that came back empty. A named place —
 * "Lidl in Bolzano" — is exactly what a text search is good at, and it is
 * still there to answer it.
 *
 * Every run logs where its time actually went (`event: "query_search"`).
 * That's here because two confident explanations for a reported four-minute
 * search were both wrong — first the prompt's coordinates (the query named
 * its own town all along), then an assumption about which tools a Claude
 * chat turn had. Neither was measured. This makes the next real search say
 * for itself: which path answered, how long each leg took, and how many
 * places came back.
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
  /** Passed straight through to the Claude fallback — see rescanCorridor. */
  existingStopNames?: string[]
  /** And the visible rectangle, likewise — see searchPlacesInRectangle. */
  bounds?: MapBounds
  areaCorners?: {
    northWest?: string
    northEast?: string
    southWest?: string
    southEast?: string
  }
}): Promise<{
  finds: RescanFind[]
  source: 'places' | 'claude'
  /**
   * Set only when Claude FAILED. Absent alongside `source: 'places'` means
   * Claude ran and had nothing to propose, which is a real answer about the
   * area rather than an outage — and the two must not read the same on
   * screen.
   */
  claudeFailure?: ClaudeFailureKind
}> {
  const startedAt = Date.now()

  // Claude first. A turn that fails outright must not fail the search — the
  // whole point of keeping Places is that it answers when this cannot.
  let claudeFinds: RescanFind[] = []
  let claudeError: string | undefined
  try {
    claudeFinds = await generateRescanCandidates(input)
  } catch (error) {
    claudeError = String(error)
    console.warn('Claude query search failed — falling back to Places', error)
  }
  const claudeMs = Date.now() - startedAt

  if (claudeFinds.length > 0) {
    logQuerySearch({
      tripId: input.tripId,
      source: 'claude',
      placesMs: 0,
      claudeMs,
      totalMs: Date.now() - startedAt,
      placesReturned: 0,
      finds: claudeFinds.length,
      claudeError,
    })
    return { finds: claudeFinds, source: 'claude' }
  }

  // Nothing from Claude — it failed, or it genuinely had nothing to say
  // about this query. A text search is good at exactly what Claude is worst
  // at: a place named outright.
  const placesStartedAt = Date.now()
  let places: QueryPlaceFind[] = []
  let placesError: string | undefined
  try {
    places = await searchPlacesByQuery(input.query, input.center, input.radiusKm)
  } catch (error) {
    placesError = String(error)
    console.warn('Places query search failed too', error)
  }
  const placesMs = Date.now() - placesStartedAt

  const located: RescanFind[] = places.slice(0, MAX_QUERY_PLACES).map((place) => ({
    name: place.name,
    country: place.country,
    why: describePlace(place, input.query),
    lat: place.lat,
    lng: place.lng,
    // These came straight from Places, so the listing link is already in
    // hand — the same link the Claude path gets from verification. There is
    // no photo here, which is one of the two reasons this is the fallback
    // rather than the default.
    ...(place.googleMapsUrl ? { googleMapsUrl: place.googleMapsUrl } : {}),
  }))
  const withinCorridor = filterFindsToCorridor(located, input)

  logQuerySearch({
    tripId: input.tripId,
    source: 'places',
    placesMs,
    claudeMs,
    totalMs: Date.now() - startedAt,
    placesReturned: places.length,
    finds: withinCorridor.length,
    placesError,
    claudeError,
  })

  /**
   * Both engines broken is a FAILURE, not an empty answer.
   *
   * Caught by an existing e2e test the moment the order was inverted, and it
   * was right to fail: with Places first, a search in an environment with no
   * credentials ended in a rejected promise and an error banner. With Claude
   * first, each failure was caught on the way to the next path and the
   * traveler was told "nothing found in that circle" — advice to widen the
   * search, for a search that never ran.
   *
   * A search that broke must never read as a search that found nothing. Note
   * the condition: both must have ERRORED. Claude answering "nothing here"
   * is a real answer even if Places then falls over, and an empty result
   * from two working engines is just an empty circle.
   */
  if (claudeError && placesError) {
    throw new Error(
      `Both searches failed — Claude: ${claudeError}; Places: ${placesError}`,
    )
  }
  return {
    finds: withinCorridor,
    source: 'places',
    ...(claudeError ? { claudeFailure: classifyClaudeFailure(claudeError) } : {}),
  }
}

function logQuerySearch(payload: {
  tripId?: string
  source: 'places' | 'claude'
  placesMs: number
  /** Time in the Claude turn, which now runs first — see above. */
  claudeMs: number
  totalMs: number
  placesReturned: number
  finds: number
  placesError?: string
  claudeError?: string
}): void {
  console.log(JSON.stringify({ event: 'query_search', ...payload }))
}
