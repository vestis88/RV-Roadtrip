import Anthropic from '@anthropic-ai/sdk'
import { defineSecret } from 'firebase-functions/params'
import type { LatLng, TripSettings } from '@rv/shared'
import { geocodeQuery, verifyPlaceLocation } from '../placesApi.js'
import { logClaudeUsage, type ClaudeCallType } from '../claudeUsageLogger.js'
import {
  buildChunkDetailPrompt,
  buildRegionHighlightsPrompt,
  buildRouteOutlinePrompt,
} from './planTripPrompt.js'
import {
  chunkDetailResponseSchema,
  planTripSkeletonSchema,
  regionHighlightsResponseSchema,
  routeOutlineSchema,
  type ChunkDetailResponse,
  type PlanTripSkeleton,
  type PlanTripSkeletonDay,
  type RegionHighlightCandidate,
  type RegionHighlightsResponse,
  type RouteOutline,
  type RouteOutlineDay,
} from './planTripSchema.js'

export const claudeApiKey = defineSecret('CLAUDE_API_KEY')

const MODEL = 'claude-sonnet-5'
const MAX_ATTEMPTS = 2
// Days per detail-expansion call. Keeps each call's output small and fast
// regardless of total trip length — a week of activities/restaurants stays
// comfortably under both the model's output ceiling and the Anthropic SDK's
// ~10-minute non-streaming guard, which a single call covering a full
// multi-week trip does not (see generatePlan.ts's history for why this
// exists: raising max_tokens on one giant call just moves the wall further
// out, it doesn't remove it).
const CHUNK_SIZE = 7

export type PlanTripProgress =
  | { phase: 'highlights' }
  | { phase: 'outline' }
  | { phase: 'detail'; chunkIndex: number; chunkCount: number }

function stripCodeFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim()
}

export function parseRegionHighlights(text: string): RegionHighlightsResponse {
  return regionHighlightsResponseSchema.parse(JSON.parse(stripCodeFences(text)))
}

/**
 * Cuts a syntactically broken response back to the longest prefix that IS
 * valid JSON, closing whatever containers are still open at that point.
 * Returns null when nothing parses.
 *
 * Exists because of a production failure on 2026-08-12 (explore highlights,
 * trip "Luxemburg"): Claude returned 5,609 characters of otherwise-complete
 * curation whose very last candidate was `{"town": "Bouillon", "country":
 * "BE", "why "}` — a key with no value. `JSON.parse` is all-or-nothing, so
 * one malformed field at the tail threw away every complete candidate
 * before it, both attempts failed the same way, and the whole callable
 * 500'd after paying for two Claude calls. The 30-day usage log shows this
 * is not a freak: 4 of 12 highlights runs needed their retry, so a run
 * where BOTH attempts miss is simply the tail of a rate the code already
 * lived with.
 *
 * Scans once, tracking string/escape state so a brace inside a `why`
 * sentence is never mistaken for structure, and records every point where a
 * container legitimately closed. Those points are then tried newest-first,
 * so the salvage keeps as much of the answer as possible; a trailing
 * sentence of prose after the closing brace (the other way a response
 * stops being parseable) is cut by the same mechanism.
 *
 * Deliberately NOT a general "repair any JSON" pass: it only ever truncates
 * at a boundary the model itself closed, so a salvaged document contains
 * only values Claude actually finished writing. Nothing is invented, and
 * the caller still validates the result against the real schema.
 */
export function salvageJsonPrefix(text: string): string | null {
  const cuts: { end: number; closers: string }[] = []
  const open: string[] = []
  let inString = false
  let escaped = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') open.push('}')
    else if (char === '[') open.push(']')
    else if (char === '}' || char === ']') {
      // A mismatched closer means the damage is structural rather than a
      // truncated tail, and every cut point recorded so far sits inside a
      // container whose nesting we can no longer trust — nothing to salvage.
      if (open.pop() !== char) return null
      cuts.push({ end: i, closers: [...open].reverse().join('') })
    }
  }

  for (let i = cuts.length - 1; i >= 0; i--) {
    const candidate = text.slice(0, cuts[i].end + 1) + cuts[i].closers
    try {
      JSON.parse(candidate)
      return candidate
    } catch {
      // This boundary sat inside the broken region; try an earlier one.
    }
  }
  return null
}

/**
 * Last-resort parse for the highlights call only — see callWithRetry's
 * `salvage` parameter for when it runs, and salvageJsonPrefix for what it
 * recovers.
 *
 * Safe for THIS call specifically because losing the truncated tail costs
 * the traveler at most the last candidate town: regionHighlightsResponseSchema
 * deliberately allows any number of regions and candidates (see its own
 * comments), so a shortened list is a valid answer rather than a corrupted
 * one. The outline and detail calls deliberately do NOT get this — dropping
 * their last element would silently shorten the trip or lose a whole day's
 * plan, which is worse than failing loudly.
 */
export function salvageRegionHighlights(text: string): RegionHighlightsResponse {
  const repaired = salvageJsonPrefix(stripCodeFences(text))
  if (repaired === null) {
    throw new Error('No parseable JSON prefix to salvage')
  }
  return regionHighlightsResponseSchema.parse(JSON.parse(repaired))
}

export function parseRouteOutline(text: string): RouteOutline {
  return routeOutlineSchema.parse(JSON.parse(stripCodeFences(text)))
}

// The schema only requires indices to be non-negative integers — nothing
// stops Claude from numbering days 1-based (the "natural" way a human
// would), which every display site silently mis-renders as "Day 2" for the
// actual first day. Validated separately from the schema itself so a
// contiguous-0-based violation retries through the same
// correct-and-resubmit loop as a schema failure, rather than only being
// caught by every downstream renderer assuming it.
export function parseAndValidateRouteOutline(text: string): RouteOutline {
  const outline = parseRouteOutline(text)
  const indices = outline.days.map((day) => day.index)
  const expected = indices.map((_, i) => i)
  const isContiguousFromZero = indices.every(
    (index, i) => index === expected[i],
  )
  if (!isContiguousFromZero) {
    throw new Error(
      `"index" must be 0-based and contiguous (0, 1, 2, …) with no gaps — got [${indices.join(', ')}]`,
    )
  }
  return outline
}

export function parseChunkDetail(text: string): ChunkDetailResponse {
  return chunkDetailResponseSchema.parse(JSON.parse(stripCodeFences(text)))
}

function textFromResponse(response: Anthropic.Message): string {
  return response.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
}

// Surfaces enough of the raw response to diagnose a parse failure from the
// planRequests error field alone — this function has no log access from the
// browser/Firestore console, so the error message itself is the only
// diagnostic channel available after the fact.
function describeResponse(response: Anthropic.Message, text: string): string {
  const blockTypes = response.content.map((block) => block.type).join(',')
  const preview =
    text.length > 300 ? `${text.slice(0, 150)}…${text.slice(-150)}` : text
  return `stop_reason=${response.stop_reason} blocks=[${blockTypes}] textLength=${text.length} preview=${JSON.stringify(preview)}`
}

// userContent accepts pre-built content blocks (not just a plain string) so
// callers can attach a prompt-cache `cache_control` breakpoint to part of it
// — see the chunk-detail loop in generateSkeletonFromHighlights below, the
// one call site in this codebase where the exact same large prefix
// (settings/notes/fullRouteOutline) is guaranteed to repeat across multiple
// back-to-back calls. Every other Claude call in functions/src/prompts is
// one-shot per trip with request-specific content (different settings/notes
// each time) and no other call sharing its prefix within the cache TTL, so a
// breakpoint there would only pay the ~1.25x cache-write premium for zero
// reads — not added for that reason, not an oversight.
async function callWithRetry<T>(
  client: Anthropic,
  system: string,
  userContent: string | Anthropic.TextBlockParam[],
  maxTokens: number,
  parse: (text: string) => T,
  usageContext: { callType: ClaudeCallType; tripId?: string },
  // Runs only once every attempt has been spent, on the last response
  // received — the alternative at that point is throwing the whole run
  // away. Given only where a partial answer is genuinely valid (see
  // salvageRegionHighlights); omitted, the call fails exactly as before.
  salvage?: (text: string) => T,
): Promise<T> {
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: userContent },
  ]

  let lastError: unknown
  let lastText: string | undefined
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let response: Anthropic.Message
    const attemptStartedAt = Date.now()
    try {
      response = await client.messages.create({
        model: MODEL,
        max_tokens: maxTokens,
        // Sonnet 5 runs adaptive thinking by default when `thinking` is
        // omitted, and thinking tokens count against max_tokens — on a call
        // where the model decides to think at length, it can exhaust the
        // whole budget before emitting any of the JSON text these prompts
        // require, ending in stop_reason=max_tokens with zero output. These
        // are schema-constrained extraction/planning calls, not open-ended
        // reasoning tasks, so thinking is turned off to keep max_tokens
        // entirely available for the actual response.
        thinking: { type: 'disabled' },
        system,
        messages,
      })
    } catch (error) {
      // A transient API-level failure (rate limit, brief overload, network
      // blip) — MAX_ATTEMPTS existing at all implies this call is meant to
      // be resilient to exactly this, not just to Claude returning
      // malformed JSON. Retries the identical request unchanged (nothing
      // was pushed onto `messages`), same as a schema-failure retry just
      // without the corrective follow-up message.
      lastError = error
      console.warn(
        `Claude ${usageContext.callType} call failed (attempt ${attempt}, trip ${usageContext.tripId ?? 'n/a'})`,
        error,
      )
      continue
    }
    logClaudeUsage({
      ...usageContext,
      attempt,
      elapsedMs: Date.now() - attemptStartedAt,
      response,
    })
    const text = textFromResponse(response)
    lastText = text

    try {
      return parse(text)
    } catch (error) {
      lastError = new Error(
        `${String(error)} | ${describeResponse(response, text)}`,
      )
      // Logged per attempt, not just thrown at the end: only the FINAL
      // attempt's error ever escapes this function, so an investigation
      // into a failed run could see how the retry went wrong but never how
      // the original response did — which is exactly the gap that made the
      // 2026-08-12 explore failure take a log dig to characterise.
      console.warn(
        `Claude ${usageContext.callType} response failed validation (attempt ${attempt}, trip ${usageContext.tripId ?? 'n/a'})`,
        lastError,
      )
      messages.push({ role: 'assistant', content: text })
      messages.push({
        role: 'user',
        content: `Your last response failed validation: ${String(error)}. Return ONLY the corrected JSON matching the schema — no prose, no markdown code fences.`,
      })
    }
  }

  if (salvage && lastText !== undefined) {
    try {
      const recovered = salvage(lastText)
      console.warn(
        `Claude ${usageContext.callType} exhausted ${MAX_ATTEMPTS} attempts; salvaged the valid prefix of the last response (trip ${usageContext.tripId ?? 'n/a'})`,
        lastError,
      )
      return recovered
    } catch (error) {
      console.warn(
        `Claude ${usageContext.callType} response could not be salvaged either (trip ${usageContext.tripId ?? 'n/a'})`,
        error,
      )
    }
  }
  throw lastError
}

/**
 * One chunk's worth of the detail phase (phase 3 — see generateSkeletonFromHighlights's
 * loop below and the corridor reconciliation's own use for a single
 * traveler-added stop, phase 4b of the persistent-corridor overhaul):
 * factored out so both callers share the exact same prompt-building,
 * retry-on-schema-failure, and cache-breakpoint-placement logic rather than
 * a second hand-rolled copy.
 */
export async function generateChunkDetail(
  client: Anthropic,
  input: {
    settings: TripSettings
    notesFreeText: string
    outline: RouteOutline
    chunkDays: RouteOutlineDay[]
  },
  options?: {
    cacheStableBlock?: boolean
    tripId?: string
    callType?: ClaudeCallType
  },
): Promise<ChunkDetailResponse> {
  const { system, stableUser, variableUser } = buildChunkDetailPrompt(input)
  const stableBlock: Anthropic.TextBlockParam = { type: 'text', text: stableUser }
  if (options?.cacheStableBlock) {
    stableBlock.cache_control = { type: 'ephemeral' }
  }
  return callWithRetry(
    client,
    system,
    [stableBlock, { type: 'text', text: variableUser }],
    16000,
    parseChunkDetail,
    { callType: options?.callType ?? 'detail', tripId: options?.tripId },
  )
}

/**
 * Phase 1 alone (see planTrip's own doc comment below for the full
 * three-phase picture) — split out for the interactive/transparent route
 * planning review pause (implemented 2026-07-27): generatePlan.ts can run
 * just this phase, show the traveler the candidate stops + reasoning, and
 * only call generateSkeletonFromHighlights once they've edited them and
 * chosen to continue.
 */
export async function generateRegionHighlights(input: {
  settings: TripSettings
  notesFreeText: string
  tripId?: string
}): Promise<RegionHighlightsResponse> {
  const client = new Anthropic({ apiKey: claudeApiKey.value() })
  const { system, user } = buildRegionHighlightsPrompt(input)
  const highlights = await callWithRetry(
    client,
    system,
    user,
    // Raised from 8000 when curation moved from towns to sights
    // (2026-08-13): a candidate now carries a sight name, a base town, the
    // interest it serves and a duration on top of the same 2-4 sentence
    // "why", and there are more of them, since a single town can be worth
    // stopping in for three different reasons. The salvage path below
    // recovers a truncated answer, but it recovers it by throwing away
    // whatever came after the cut — cheaper to not hit the ceiling.
    12000,
    parseRegionHighlights,
    { callType: 'highlights', tripId: input.tripId },
    // The only call given a salvage path — a curation shortlist stays a
    // valid answer with its last entry missing, unlike a route or a day's
    // detail. See salvageRegionHighlights.
    salvageRegionHighlights,
  )
  return geocodeHighlights(highlights, input.settings)
}

/**
 * How far a sight may sit from the town proposed as its base and still be
 * accepted as that candidate's location.
 *
 * Doing double duty. It is the promise the candidate makes — "sleep here,
 * see this" — so a match half a country away is not the sight that was
 * asked for even if it shares the name. And it is the fraud check: Places'
 * locationBias will happily answer a query for a place that doesn't exist
 * with the best-known namesake anywhere on earth, which is how a Helsingør
 * dinner stop became a hotel in Greece (see MAX_MATCH_DISTANCE_KM in
 * placesApi.ts). Half an hour's drive, the same distance the curation prompt
 * asks for when it says "nearest sensible town".
 */
const MAX_SIGHT_FROM_BASE_TOWN_KM = 30

/**
 * Resolves each candidate SIGHT to coordinates, so the explore map pins the
 * thing the traveler is deciding on and the detour estimate measures the
 * drive they would actually make. Claude is deliberately not asked for
 * coordinates (models invent plausible-looking wrong ones); these come from
 * Places.
 *
 * Two lookups, not one, and the order matters. The base town is geocoded
 * first because towns resolve reliably and unambiguously — that is the
 * anchor. The sight is then looked up against that anchor and must clear
 * both a distance bound and a name check (verifyPlaceLocation) before it is
 * believed. A named sight is nothing like a town here: it may not exist, may
 * be spelled a way Places doesn't know, or may share its name with something
 * famous elsewhere, and a plain first-result geocode answers all three with
 * a confident pin in the wrong place.
 *
 * Best-effort by design, per candidate: geocodeQuery throws when
 * GOOGLE_PLACES_API_KEY is unset and either lookup can fail on a transient
 * error, and none of that is worth failing a whole trip generation over. A
 * candidate that can't be pinned down keeps its other fields and carries no
 * lat/lng — which buildExploreCandidateWrites drops rather than writes,
 * deliberately: an unverifiable sight is exactly the one whose location
 * would be wrong, and a wrong pin is worse than a missing suggestion.
 * Biased near startPoint for the town lookup: a single global bias point is
 * enough to disambiguate town names at this scale, and the query carries the
 * country too.
 */
async function geocodeHighlights(
  highlights: RegionHighlightsResponse,
  settings: TripSettings,
): Promise<RegionHighlightsResponse> {
  const near = settings.startPoint
  if (!near) return highlights

  const located = await Promise.all(
    highlights.regions.map(async (region) => ({
      ...region,
      candidateStops: await Promise.all(
        region.candidateStops.map((stop) => locateCandidateSight(stop, near)),
      ),
    })),
  )

  return { regions: located }
}

async function locateCandidateSight(
  stop: RegionHighlightCandidate,
  near: LatLng,
): Promise<RegionHighlightCandidate> {
  try {
    const townPoint = await geocodeQuery(`${stop.town}, ${stop.country}`, near)
    if (!townPoint) {
      console.info(
        `Highlight candidate "${stop.sight}" dropped — its base town "${stop.town}, ${stop.country}" did not resolve, so there is nothing to check the sight against`,
      )
      return stop
    }
    const sight = await verifyPlaceLocation(
      `${stop.sight}, ${stop.town}, ${stop.country}`,
      stop.sight,
      townPoint,
      MAX_SIGHT_FROM_BASE_TOWN_KM,
    )
    if (!sight) {
      console.info(
        `Highlight candidate "${stop.sight}" dropped — no place by that name within ${MAX_SIGHT_FROM_BASE_TOWN_KM} km of ${stop.town}, ${stop.country}`,
      )
      return stop
    }
    // Places' own spelling wins from here on: it is what the traveler will
    // see on the map, and it gives the sight one stable identity across
    // repeated curation passes (see buildExploreCandidateWrites' merge).
    return { ...stop, sight: sight.name, lat: sight.lat, lng: sight.lng }
  } catch (error) {
    console.warn(
      `Locating highlight candidate "${stop.sight}, ${stop.town}, ${stop.country}" failed — continuing without coordinates`,
      error,
    )
    return stop
  }
}

/**
 * Phases 2 ("outline") and 3 ("detail", chunked) — given highlights already
 * resolved (either freshly, via planTrip below, or a traveler-edited set
 * from the review pause), sequences them into a day-by-day route and fills
 * in each day's activities/restaurants.
 */
export async function generateSkeletonFromHighlights(input: {
  settings: TripSettings
  notesFreeText: string
  highlights: RegionHighlightsResponse
  tripId?: string
  onProgress?: (
    progress: Extract<PlanTripProgress, { phase: 'outline' | 'detail' }>,
  ) => void
}): Promise<PlanTripSkeleton> {
  const client = new Anthropic({ apiKey: claudeApiKey.value() })
  const { highlights } = input

  input.onProgress?.({ phase: 'outline' })
  const { system: outlineSystem, user: outlineUser } = buildRouteOutlinePrompt({
    ...input,
    highlights,
  })
  const outline = await callWithRetry(
    client,
    outlineSystem,
    outlineUser,
    8000,
    parseAndValidateRouteOutline,
    { callType: 'outline', tripId: input.tripId },
  )

  const chunks: RouteOutline['days'][] = []
  for (let i = 0; i < outline.days.length; i += CHUNK_SIZE) {
    chunks.push(outline.days.slice(i, i + CHUNK_SIZE))
  }

  const detailByIndex = new Map<number, ChunkDetailResponse['days'][number]>()
  for (let c = 0; c < chunks.length; c++) {
    input.onProgress?.({
      phase: 'detail',
      chunkIndex: c + 1,
      chunkCount: chunks.length,
    })
    const detail = await generateChunkDetail(
      client,
      {
        settings: input.settings,
        notesFreeText: input.notesFreeText,
        outline,
        chunkDays: chunks[c],
      },
      {
        // Only worth caching the stable settings/notes/fullRouteOutline block
        // when there's a second chunk to read it back — a single-chunk trip
        // (<= CHUNK_SIZE days) would just pay the write premium for zero reads.
        cacheStableBlock: chunks.length > 1,
        tripId: input.tripId,
      },
    )
    for (const day of detail.days) {
      detailByIndex.set(day.index, day)
    }
  }

  const days: PlanTripSkeletonDay[] = outline.days.map((outlineDay) => {
    const detail = detailByIndex.get(outlineDay.index)
    if (!detail) {
      throw new Error(
        `Claude never returned detail for day index ${outlineDay.index}`,
      )
    }
    return {
      index: outlineDay.index,
      date: outlineDay.date,
      type: outlineDay.type,
      overnight: outlineDay.overnight,
      drive: outlineDay.drive,
      summary: detail.summary,
      extraTimeReason: detail.extraTimeReason,
      highlightReason: outlineDay.highlightReason,
      activities: detail.activities,
      restaurants: detail.restaurants,
    }
  })

  return planTripSkeletonSchema.parse({ days })
}

/**
 * Plans a trip in three phases, each with a narrower job than the last:
 *
 * 1. "highlights" (generateRegionHighlights) — pure curation, no dates or
 *    pacing involved. Reasons region-by-region about what's actually worth
 *    seeing for these travelers' interests and produces a ranked shortlist
 *    of candidate stops. This is what makes route selection interest-driven
 *    rather than defaulting to whatever's closest to the direct line — the
 *    model decides what's good BEFORE it's under any pressure to make the
 *    schedule fit.
 * 2. "outline" (generateSkeletonFromHighlights) — selects from that
 *    shortlist (prioritizing must-sees) and sequences the selections into
 *    an actual day-by-day route from the real start point to the real end
 *    point, so pacing and the final destination are still solved with the
 *    whole trip in view.
 * 3. "detail" (generateSkeletonFromHighlights, chunked) — the route is
 *    split into fixed-size chunks and each chunk's activities/restaurants
 *    are filled in by a separate call that's given the full outline for
 *    context but can only elaborate on its own days — it cannot redirect
 *    the route.
 *
 * Every individual call stays small and fast regardless of trip length,
 * unlike asking for the whole curated, scheduled, detailed itinerary in one
 * shot. Split into two exported functions above (rather than one inline
 * pipeline) so generatePlan.ts's review-pause flow can run just phase 1,
 * show the traveler the result, and resume into phases 2-3 later with
 * their edits — this function is the default "run the whole thing" path
 * used when that pause isn't requested.
 */
export async function planTrip(input: {
  settings: TripSettings
  notesFreeText: string
  tripId?: string
  onProgress?: (progress: PlanTripProgress) => void
}): Promise<PlanTripSkeleton> {
  input.onProgress?.({ phase: 'highlights' })
  const highlights = await generateRegionHighlights(input)
  return generateSkeletonFromHighlights({ ...input, highlights })
}
