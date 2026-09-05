import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { defineSecret } from 'firebase-functions/params'
import {
  boundsContain,
  boundsHalfDiagonalKm,
  estimateDetourKm,
  haversineDistanceKm,
  type LatLng,
  type MapBounds,
} from '@rv/shared'
import {
  searchPlacesInArea,
  SWEEP_COVERS_UP_TO_KM,
  searchPlacesInRectangle,
  verifyPlaceLocation,
} from '../placesApi.js'
import { logClaudeUsage } from '../claudeUsageLogger.js'
import { buildRescanCorridorPrompt } from './rescanCorridorPrompt.js'
import { extractJsonObject } from './jsonFromClaude.js'

export const claudeApiKey = defineSecret('CLAUDE_API_KEY')

const MODEL = 'claude-sonnet-5'
const MAX_ATTEMPTS = 2
/**
 * WEB SEARCH, AND WHY THIS CALL NO LONGER USES IT (2026-08-16).
 *
 * A rescan used to run `web_search` with `max_uses: 3`, and the prompt's
 * third hard rule was "ground every suggestion in something you actually
 * found via web search... respond with an empty finds list rather than
 * padding". That made the search a GATE on what could be proposed rather
 * than a source: three queries over a whole viewport, and anything they
 * missed was forbidden — including everything the model already knew.
 *
 * Reported as a rescan of the Hallandsåsen area answering "Nothing new found
 * nearby" with Vallåsen Bike Park inside the circle. Grounding was never
 * what web search was buying, either: every find is looked up through Google
 * Places afterwards and dropped if it can't be located, which is the same
 * and stronger check the whole-trip curation phase relies on — and that
 * phase calls Claude with no tools at all and proposes bike parks by name.
 *
 * So the tool is gone. It cost minutes per turn, it was the sole reason this
 * call needed streaming, pause-turn resumption and a wall-clock budget, and
 * it suppressed correct answers. querySearch.ts reached the same conclusion
 * for typed queries in 2026-08-02 and moved to Places-first; this is the
 * same lesson arriving at the other path.
 */

/**
 * How much wall time to reserve for one more Claude turn — the retry is
 * skipped rather than started when the budget can't hold it. Far less
 * binding now that a turn is one tool-free call rather than up to four
 * searching ones, but kept: the caller still owns the deadline, and being
 * killed mid-write with everything discarded is still the failure to avoid.
 */
const TURN_RESERVE_MS = 90_000

/**
 * The budget assumed when no caller supplies one — the debug tool and the
 * unit tests. Deliberately not read from the callable's timeoutSeconds:
 * a default that silently tracked production config would hide the fact
 * that the real budget is the caller's to state.
 */
const DEFAULT_SEARCH_BUDGET_MS = 240_000

/**
 * How large a "rescan this area" search radius is allowed to be, in
 * kilometres. This is a traveler-triggered, on-demand Claude call with no
 * per-trip cost guard (unlike full generation/replan, it never
 * touches `planMeta.status` or the days collection, so concurrent rescans
 * are merely redundant, not corrupting) — the radius cap is what keeps a
 * single call bounded, per master_plan.md's "explicit cap/viewport-scoping
 * story" requirement for this phase.
 */
export const MAX_RESCAN_RADIUS_KM = 150

/** Caps how many proposed stops one rescan can add — a single search
 * shouldn't be able to flood the corridor with dozens of unreviewed pins. */
export const MAX_RESCAN_RESULTS = 12

/**
 * How many finds to ASK for, which is not the same as how many to allow.
 *
 * Reported 2026-09-05 over a 150 km circle across central Italy: *"Searched
 * 150 km of Italy and it found one stop?! I want it to find the best of the
 * region. There must be A LOT more!!"* — and the model had indeed proposed
 * exactly one place, which then failed its map lookup, so the traveler got
 * nothing at all from a search that ran for minutes.
 *
 * `MAX_RESCAN_RESULTS` has always existed, but it is a server-side slice the
 * model has never been told about. The only things the prompt said about
 * quantity were "do not pad" and "an empty list is a valid and honest
 * answer" — both arguments for fewer, with nothing on the other side. One
 * find was the model doing as it was asked.
 *
 * Scaled by the ground being covered, because the honest number genuinely
 * differs: a 150 km circle across a European region holds a dozen good
 * stops, and a 5 km circle around a mountain hut holds a handful. A corridor
 * search covers the whole route, so it gets the wide figure.
 */
export function targetFindCount(input: {
  radiusKm: number
  isCorridor: boolean
  /**
   * A typed query wants a handful of matches rather than a survey — and it
   * is answered on a smaller output budget (see runSearchTurn), so asking
   * for a dozen four-sentence entries is asking to be cut off mid-JSON.
   */
  isQuery: boolean
}): number {
  if (input.isQuery) return 6
  if (input.isCorridor || input.radiusKm >= 75) return MAX_RESCAN_RESULTS
  if (input.radiusKm >= 25) return 8
  return 5
}

/**
 * When searching along a route backbone (see `backbone` below) instead of a
 * plain point+radius, this is the filter that replaces `radiusKm`: how far
 * off the corridor a find is allowed to sit, measured the same way
 * ExploreCandidateCard's own detour badges are (estimateDetourKm — cheapest
 * extra km via this point on top of whatever backbone leg it's nearest).
 * Deliberately smaller than MAX_RESCAN_RADIUS_KM: "along the route" implies
 * a genuinely minor detour, not a 50km side trip.
 */
export const MAX_QUERY_SEARCH_DETOUR_KM = 30

/**
 * How many of the circle's real places to put in front of the model.
 *
 * Enough that a quiet valley is fully described and a busy one is well
 * represented; not so many that the list becomes the answer. The model is
 * still choosing what is worth stopping FOR — that judgement is the reason
 * this call exists at all, and a raw Places dump ranked by rating is exactly
 * what it is not.
 */
const MAX_PLACES_IN_AREA = 40

const rescanCandidateSchema = z.object({
  name: z.string(),
  country: z.string().length(2),
  why: z.string(),
})

const rescanResponseSchema = z.object({
  // May be empty — "nothing worthwhile nearby" is a real, expected outcome
  // for a point-and-radius search, not a validation failure.
  finds: z.array(rescanCandidateSchema),
})

/**
 * The finds in a search response, whatever Claude wrapped them in.
 *
 * This used to be `JSON.parse(stripCodeFences(text))`, and that single line
 * is the best explanation there is for why a rescan appeared never to work.
 * It was one of three Claude calls running web_search, and a turn
 * grounded in sources is the one most likely to say so — an opening sentence
 * before the JSON, or a "let me know if you'd like me to widen the search"
 * after it. Both throw. Every other symptom followed from that: minutes
 * spent, nothing found, a second full web search bought to reach the same
 * ending, and an error blaming malformed JSON for what was a complete,
 * correct answer with a sentence of politeness attached.
 *
 * The highlights path was given exactly this tolerance in 2026-08-12 (see
 * jsonFromClaude.ts) after the same failure on the tool-free call, where it
 * was measurably rarer. This path never got it.
 */
export function parseRescanResponse(text: string) {
  return rescanResponseSchema.parse(JSON.parse(extractJsonObject(text)))
}

function textFromResponse(response: Anthropic.Message): string {
  return response.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
}

export interface RescanFind {
  name: string
  country: string
  why: string
  lat: number
  lng: number
  /**
   * Google's own URL for the listing this find was verified against.
   *
   * Absent before 2026-08-16, which is why "Photos & details" on a rescan
   * find fell back to searching Google for the name Claude had given it —
   * and a name Claude had given it is exactly what could not be trusted.
   */
  googleMapsUrl?: string
  /** Google's own photo of that listing — see VerifiedPlace.photoUrl. */
  photoUrl?: string
}

/**
 * Searches near `center` for stops worth adding to the corridor, within
 * `radiusKm` — or, when `backbone` is given (2026-08-01, the explore-mode
 * route corridor — see buildRescanCorridorPrompt's own doc comment), along
 * that whole route instead, filtered by detour-off-backbone rather than
 * distance from one point. Each find is geocoded (still biased near
 * `center` either way — a reasonable bias point regardless of which filter
 * applies) and then actually measured server-side — a find that doesn't
 * geocode is dropped (nothing to check its distance/detour against).
 */
/**
 * One attempt, streamed.
 *
 * Streamed because a survey-sized answer is exactly the shape that runs out
 * a single non-streaming request's timeout. Streaming holds the connection
 * open through the whole generation instead, which is the documented remedy;
 * `finalMessage()` hands back the same assembled message the non-streaming
 * call would have returned, so nothing downstream changes.
 *
 * No tools. See RESCAN_SYSTEM_PROMPT and the note on WEB SEARCH below for
 * why the web_search tool was removed rather than tuned — and with it the
 * pause-turn resumption this function used to carry, which only ever existed
 * because a server-side tool can pause a turn. Without a server tool there
 * is no paused turn to resume.
 */
async function runSearchTurn(
  client: Anthropic,
  system: string,
  messages: Anthropic.MessageParam[],
  input: { query?: string },
): Promise<Anthropic.Message> {
  const stream = client.messages.stream({
    model: MODEL,
    // A focused query wants a handful of matches, not a survey — and output
    // length is paid for in wall time, on the call the traveler is sitting
    // and waiting for. The general "what's worth stopping for here" pass
    // still gets the full budget.
    max_tokens: input.query ? 1500 : 4000,
    thinking: { type: 'disabled' },
    system,
    messages,
  })
  return stream.finalMessage()
}

/**
 * The error to keep when a turn produced nothing usable.
 *
 * "Unexpected end of JSON input" is what a truncated or absent answer
 * reported, and it is actively misleading: it reads as Claude returning
 * malformed JSON, which is a prompt problem, when the actual event was a
 * turn that filled its output budget or ran out of time mid-search. Those
 * have completely different fixes, and the wrong one was on screen — and in
 * the logs — for every one of these failures.
 */
function describeUnusableResponse(
  response: Anthropic.Message,
  text: string,
  parseError: unknown,
): Error {
  if (response.stop_reason === 'max_tokens') {
    return new Error(
      'The search answer was cut off before it finished — it ran out of output length.',
    )
  }
  if (text.trim().length === 0) {
    return new Error('The search returned no answer at all.')
  }
  return parseError instanceof Error ? parseError : new Error(String(parseError))
}

export async function generateRescanCandidates(input: {
  center: LatLng
  radiusKm: number
  /**
   * The rectangle the traveler can actually see, when the client sent one.
   * Takes over from `center`/`radiusKm` for both halves of the search: the
   * Places sweep restricts to it natively at any size, and the filter below
   * asks whether a find is inside it rather than how far it is from a point.
   */
  bounds?: MapBounds
  notesFreeText?: string
  /** The trip's stated interests — see buildRescanCorridorPrompt's own note. */
  interests?: string[]
  tripId?: string
  query?: string
  backbone?: LatLng[]
  centerName?: string
  waypointNames?: string[]
  /** The stops this trip already has — see buildRescanCorridorPrompt. */
  existingStopNames?: string[]
  /** The visible rectangle's corners in names — see buildRescanCorridorPrompt. */
  areaCorners?: {
    northWest?: string
    northEast?: string
    southWest?: string
    southEast?: string
  }
  /** And the regions it spans — see describeSearchArea. */
  areaRegions?: string[]
  areaCountries?: string[]
  /**
   * When this whole search has to be finished, as an epoch millisecond.
   * Supplied by the callable from its own remaining budget so the search
   * stops itself in time to geocode and write what it found, rather than
   * being killed by the function timeout with everything discarded.
   * Defaults to a self-contained budget for the debug tool and tests.
   */
  deadlineMs?: number
}): Promise<RescanFind[]> {
  const client = new Anthropic({ apiKey: claudeApiKey.value() })
  // What is ACTUALLY in the circle, before asking anyone to remember.
  //
  // Only for a plain point-and-radius sweep: a backbone search spans a whole
  // corridor rather than a circle, and a typed query already has its own
  // Places-first path in querySearch.ts. A failure here is not fatal — the
  // prompt simply goes out without the list, exactly as it did before.
  let placesInArea: string[] = []
  // Not above SWEEP_COVERS_UP_TO_KM. Places caps a nearby search at 50 km,
  // so on a 150 km circle the sweep surveys the middle third and knows
  // nothing about the rest — and a partial list offered as a complete one is
  // worse than no list, because everything absent from it reads as absent
  // from the ground.
  //
  // That is also exactly where the model's own knowledge is at its best: ask
  // it what is worth stopping for within 150 km of a named town and it
  // answers well, which it has done since this feature existed. The sweep
  // exists for the small circle, where that question is unanswerable. It is
  // a source for the wide one, not a replacement.
  if (!input.backbone) {
    try {
      // Only for an area small enough that recall is genuinely impossible.
      //
      // The sweep briefly ran at every size, on the reasoning that a
      // rectangle restriction covers what it claims to. It was pulled back
      // the same day, on: *"I don't want google places to cloud Claude's own
      // thinking here!"* — which is right, and is the whole reason this
      // ceiling existed before there was a rectangle to argue about. Forty
      // Places names ranked by review count across a region IS an answer,
      // ranked by popularity, and handing it over is handing over the one
      // judgement this call exists to make. At a few kilometres there is no
      // judgement to lose: nobody can recall what is within 6 km of a name,
      // and the list is the only way the question is answerable at all.
      //
      // Above it, the search is told what the AREA is instead — its regions,
      // its span, its corners, all from the geocoder rather than from Places
      // — and what is worth stopping for inside it stays Claude's.
      if (input.bounds && boundsHalfDiagonalKm(input.bounds) <= SWEEP_COVERS_UP_TO_KM) {
        const inView = await searchPlacesInRectangle(input.bounds)
        placesInArea = inView.slice(0, MAX_PLACES_IN_AREA).map((place) => place.name)
        console.info(
          `Rectangle sweep found ${inView.length} places inside the visible map`,
        )
      } else if (input.radiusKm <= SWEEP_COVERS_UP_TO_KM) {
        const nearby = await searchPlacesInArea(input.center, input.radiusKm)
        placesInArea = nearby.slice(0, MAX_PLACES_IN_AREA).map((place) => place.name)
        console.info(
          `Area sweep found ${nearby.length} places within ${input.radiusKm} km of the map centre`,
        )
      }
    } catch (error) {
      console.warn('Area sweep failed — searching without it', error)
    }
  }
  const { system, user } = buildRescanCorridorPrompt({
    ...input,
    placesInArea,
    ...(input.bounds
      ? {
          areaSpanKm: {
            width: Math.round(
              haversineDistanceKm(
                { lat: input.bounds.north, lng: input.bounds.west },
                { lat: input.bounds.north, lng: input.bounds.east },
              ),
            ),
            height: Math.round(
              haversineDistanceKm(
                { lat: input.bounds.north, lng: input.bounds.west },
                { lat: input.bounds.south, lng: input.bounds.west },
              ),
            ),
          },
        }
      : {}),
    targetFinds: targetFindCount({
      radiusKm: input.radiusKm,
      isCorridor: !!input.backbone && input.backbone.length >= 2,
      isQuery: !!input.query,
    }),
  })
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: user }]

  let found: z.infer<typeof rescanResponseSchema> | undefined
  let lastError: unknown
  const startedAt = Date.now()
  const deadlineMs = input.deadlineMs ?? startedAt + DEFAULT_SEARCH_BUDGET_MS
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0 && Date.now() + TURN_RESERVE_MS > deadlineMs) {
      console.warn(
        `Skipping rescan retry — ${Math.round((Date.now() - startedAt) / 1000)}s spent, no room for another turn`,
      )
      break
    }
    let response: Anthropic.Message
    const attemptStartedAt = Date.now()
    try {
      response = await runSearchTurn(client, system, messages, input)
    } catch (error) {
      // A transient API-level failure (rate limit, brief overload, network
      // blip), not Claude returning malformed JSON — MAX_ATTEMPTS existing
      // at all implies resilience to exactly this. Previously this threw
      // immediately on attempt 0 with no retry at all, surfacing as a
      // generic "Could not rescan this area right now" on the very first
      // transient blip. Retries the identical request unchanged.
      lastError = error
      continue
    }
    logClaudeUsage({
      callType: 'rescan',
      tripId: input.tripId,
      attempt,
      elapsedMs: Date.now() - attemptStartedAt,
      response,
    })
    const text = textFromResponse(response)

    try {
      found = parseRescanResponse(text)
      break
    } catch (error) {
      lastError = describeUnusableResponse(response, text, error)
      // Only ever quote back something there is something to quote. An
      // assistant turn with empty content is rejected outright by the API,
      // so pushing one turned "the model returned no text" into a 400 on the
      // retry — a different, more confusing error than the one that
      // happened, on the attempt that was supposed to recover from it.
      if (text.trim().length > 0) {
        messages.push({ role: 'assistant', content: text })
        messages.push({
          role: 'user',
          content: `Your last response failed validation: ${String(error)}. Return ONLY the corrected JSON matching the schema — no prose, no markdown code fences.`,
        })
      }
    }
  }

  if (!found) throw lastError
  if (found.finds.length === 0) return []

  // A lookup that THREW is not a place that does not exist. Keeping them
  // apart is the whole point of this list — see the check below.
  const lookupErrors: unknown[] = []
  const located = await Promise.all(
    found.finds.map(async (find) => {
      try {
        // verifyPlaceLocation, not geocodeQuery. geocodeQuery takes Places'
        // FIRST result and returns nothing but a coordinate — placesApi.ts
        // says in as many words that this "is exactly wrong for a named
        // sight". Reported with a screenshot: a find card reading "Vrå Bike
        // Park" whose pin sat precisely on Vallåsen Bike Park. Places had
        // resolved the query correctly and handed back the real listing —
        // its own name and its own URL — and both were thrown away, leaving
        // Claude's version of the name on the card and no listing link at
        // all. So "Photos & details" searched Google for a name that does
        // not exist, and landed on the village of Vrå, an hour away.
        //
        // Taking Places' spelling is the whole point (see its own note on
        // collapsing "Kronborg"/"Kronborg Slot"/"Kronborg Castle" onto one
        // identity): the name a traveler reads is then one a map can find.
        //
        // Identity is all that is checked here — distance is deliberately
        // unbounded. filterFindsToCorridor below is the geography gate and
        // has to stay the only one, or a search along a route backbone would
        // silently lose every find more than 30km from the map centre.
        const verified = await verifyPlaceLocation(
          `${find.name}, ${find.country}`,
          find.name,
          input.center,
          Number.POSITIVE_INFINITY,
        )
        if (!verified) return null
        return {
          ...find,
          name: verified.name,
          lat: verified.lat,
          lng: verified.lng,
          ...(verified.googleMapsUrl ? { googleMapsUrl: verified.googleMapsUrl } : {}),
          ...(verified.photoUrl ? { photoUrl: verified.photoUrl } : {}),
        }
      } catch (error) {
        lookupErrors.push(error)
        console.warn(`Verifying rescan find "${find.name}, ${find.country}" failed — dropping it`, error)
        return null
      }
    }),
  )

  // Every find proposed, every lookup thrown, nothing located: that is the
  // place lookup being down, not five places that do not exist. Reported as
  // "Suggested 5 places, but none of them could be found on the map" — a
  // sentence about the places, when the sentence should have been about
  // Places. Throwing puts the real cause where every other failure now goes:
  // onto the trip, onto the screen, and into the logs with its own message.
  if (
    lookupErrors.length > 0 &&
    located.every((find) => find === null)
  ) {
    throw lookupErrors[0]
  }

  return filterFindsToCorridor(located, input)
}

/**
 * Drops finds that aren't actually where the traveler is looking — the same
 * measurement whether the find came from Claude or straight from Places, so
 * both paths honour the same "along this route" / "within this radius"
 * promise the form makes.
 */
export function filterFindsToCorridor(
  finds: (RescanFind | null)[],
  bounds: {
    center: LatLng
    radiusKm: number
    backbone?: LatLng[]
    /**
     * The visible rectangle, when the client sent one. It answers the
     * question the traveler is actually asking — "is this in what I can
     * see?" — where a circle around the centre answered a different one and
     * threw away the corners of the screen to do it (2026-09-05).
     */
    bounds?: MapBounds
  },
): RescanFind[] {
  // Kept as a property on the returned array rather than changing the return
  // type: every caller wants the finds, and only the one that reports back to
  // the traveler wants the count. See droppedForDistance().
  const useBackbone = bounds.backbone && bounds.backbone.length >= 2
  const filtered = finds.filter((find): find is RescanFind => {
    if (!find) return false
    if (useBackbone) {
      const detourKm = estimateDetourKm(find, bounds.backbone!)
      if (detourKm > MAX_QUERY_SEARCH_DETOUR_KM) {
        console.info(
          `Dropping rescan find "${find.name}" — ≈${Math.round(detourKm)} km detour off route (max ${MAX_QUERY_SEARCH_DETOUR_KM} km)`,
        )
        return false
      }
      return true
    }
    if (bounds.bounds) {
      if (!boundsContain(bounds.bounds, find)) {
        console.info(
          `Dropping rescan find "${find.name}" — outside the visible map rectangle`,
        )
        return false
      }
      return true
    }
    const distanceKm = haversineDistanceKm(find, bounds.center)
    if (distanceKm > bounds.radiusKm) {
      console.info(
        `Dropping rescan find "${find.name}" — ≈${Math.round(distanceKm)} km away (radius ${bounds.radiusKm} km)`,
      )
      return false
    }
    return true
  })

  const kept = filtered.slice(0, MAX_RESCAN_RESULTS)
  const located = finds.filter((find) => find !== null).length
  return withCounts(kept, {
    tooFar: located - filtered.length,
    notLocated: finds.length - located,
  })
}

const DROPPED_FOR_DISTANCE = Symbol('droppedForDistance')
const NOT_LOCATED = Symbol('notLocated')

function withCounts(
  finds: RescanFind[],
  counts: { tooFar: number; notLocated: number },
): RescanFind[] {
  Object.defineProperty(finds, DROPPED_FOR_DISTANCE, {
    value: counts.tooFar,
    enumerable: false,
  })
  return Object.defineProperty(finds, NOT_LOCATED, {
    value: counts.notLocated,
    enumerable: false,
  })
}

/**
 * How many places this search proposed that could not be found on the map at
 * all, and were therefore dropped before the traveler ever saw them.
 *
 * The other half of the fork the debug tool was built around (see
 * debug/curate.ts): a candidate with no coordinates was proposed and then
 * rejected by verification, and one that never appears was never proposed.
 * They have completely different fixes — a broken or restricted Places key
 * versus a search that answered the wrong question — and "Nothing new found
 * nearby" is what both of them looked like from the map. Counting them apart
 * is what makes the next empty rescan diagnosable instead of another guess.
 */
export function notLocated(finds: RescanFind[]): number {
  return (finds as unknown as Record<symbol, number>)[NOT_LOCATED] ?? 0
}

/**
 * How many real, locatable places this search found and then threw away for
 * being outside the area it was told to search.
 *
 * Reported as a search that ran for minutes and "came up empty". Empty was
 * only ever half true: the model found places, they geocoded fine, and then
 * the radius check discarded them — server-side, at console.info, while the
 * traveler was told "Nothing new found nearby". That sentence is the part
 * that made this look broken rather than merely narrow, because it describes
 * a completely different failure from the one that happened.
 */
export function droppedForDistance(finds: RescanFind[]): number {
  return (finds as unknown as Record<symbol, number>)[DROPPED_FOR_DISTANCE] ?? 0
}
