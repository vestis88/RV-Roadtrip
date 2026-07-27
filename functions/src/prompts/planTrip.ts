import Anthropic from '@anthropic-ai/sdk'
import { defineSecret } from 'firebase-functions/params'
import type { TripSettings } from '@rv/shared'
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
  type RegionHighlightsResponse,
  type RouteOutline,
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
  const isContiguousFromZero = indices.every((index, i) => index === expected[i])
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

async function callWithRetry<T>(
  client: Anthropic,
  system: string,
  userContent: string,
  maxTokens: number,
  parse: (text: string) => T,
): Promise<T> {
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userContent }]

  let lastError: unknown
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const response = await client.messages.create({
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
    const text = textFromResponse(response)

    try {
      return parse(text)
    } catch (error) {
      lastError = new Error(`${String(error)} | ${describeResponse(response, text)}`)
      messages.push({ role: 'assistant', content: text })
      messages.push({
        role: 'user',
        content: `Your last response failed validation: ${String(error)}. Return ONLY the corrected JSON matching the schema — no prose, no markdown code fences.`,
      })
    }
  }

  throw lastError
}

/**
 * Plans a trip in three phases, each with a narrower job than the last:
 *
 * 1. "highlights" — pure curation, no dates or pacing involved. Reasons
 *    region-by-region about what's actually worth seeing for these
 *    travelers' interests and produces a ranked shortlist of candidate
 *    stops. This is what makes route selection interest-driven rather than
 *    defaulting to whatever's closest to the direct line — the model
 *    decides what's good BEFORE it's under any pressure to make the
 *    schedule fit.
 * 2. "outline" — selects from that shortlist (prioritizing must-sees) and
 *    sequences the selections into an actual day-by-day route from the real
 *    start point to the real end point, so pacing and the final destination
 *    are still solved with the whole trip in view.
 * 3. "detail" (chunked) — the route is split into fixed-size chunks and
 *    each chunk's activities/restaurants are filled in by a separate call
 *    that's given the full outline for context but can only elaborate on
 *    its own days — it cannot redirect the route.
 *
 * Every individual call stays small and fast regardless of trip length,
 * unlike asking for the whole curated, scheduled, detailed itinerary in one
 * shot.
 */
export async function planTrip(input: {
  settings: TripSettings
  notesFreeText: string
  onProgress?: (progress: PlanTripProgress) => void
}): Promise<PlanTripSkeleton> {
  const client = new Anthropic({ apiKey: claudeApiKey.value() })

  input.onProgress?.({ phase: 'highlights' })
  const { system: highlightsSystem, user: highlightsUser } = buildRegionHighlightsPrompt(input)
  const highlights = await callWithRetry(
    client,
    highlightsSystem,
    highlightsUser,
    8000,
    parseRegionHighlights,
  )

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
  )

  const chunks: RouteOutline['days'][] = []
  for (let i = 0; i < outline.days.length; i += CHUNK_SIZE) {
    chunks.push(outline.days.slice(i, i + CHUNK_SIZE))
  }

  const detailByIndex = new Map<number, ChunkDetailResponse['days'][number]>()
  for (let c = 0; c < chunks.length; c++) {
    input.onProgress?.({ phase: 'detail', chunkIndex: c + 1, chunkCount: chunks.length })
    const { system, user } = buildChunkDetailPrompt({
      settings: input.settings,
      notesFreeText: input.notesFreeText,
      outline,
      chunkDays: chunks[c],
    })
    const detail = await callWithRetry(client, system, user, 16000, parseChunkDetail)
    for (const day of detail.days) {
      detailByIndex.set(day.index, day)
    }
  }

  const days: PlanTripSkeletonDay[] = outline.days.map((outlineDay) => {
    const detail = detailByIndex.get(outlineDay.index)
    if (!detail) {
      throw new Error(`Claude never returned detail for day index ${outlineDay.index}`)
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
