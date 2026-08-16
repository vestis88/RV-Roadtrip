import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { defineSecret } from 'firebase-functions/params'
import { estimateDetourKm, haversineDistanceKm, type LatLng } from '@rv/shared'
import { geocodeQuery } from '../placesApi.js'
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
export const MAX_RESCAN_RADIUS_KM = 50

/** Caps how many proposed stops one rescan can add — a single search
 * shouldn't be able to flood the corridor with dozens of unreviewed pins. */
export const MAX_RESCAN_RESULTS = 10

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
  notesFreeText?: string
  /** The trip's stated interests — see buildRescanCorridorPrompt's own note. */
  interests?: string[]
  tripId?: string
  query?: string
  backbone?: LatLng[]
  centerName?: string
  waypointNames?: string[]
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
  const { system, user } = buildRescanCorridorPrompt(input)
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

  const located = await Promise.all(
    found.finds.map(async (find) => {
      try {
        const point = await geocodeQuery(`${find.name}, ${find.country}`, input.center)
        return point ? { ...find, ...point } : null
      } catch (error) {
        console.warn(`Geocoding rescan find "${find.name}, ${find.country}" failed — dropping it`, error)
        return null
      }
    }),
  )

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
  bounds: { center: LatLng; radiusKm: number; backbone?: LatLng[] },
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
