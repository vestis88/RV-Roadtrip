import Anthropic from '@anthropic-ai/sdk'
import { defineSecret } from 'firebase-functions/params'
import type { TripSettings } from '@rv/shared'
import { buildChunkDetailPrompt, buildRouteOutlinePrompt } from './planTripPrompt.js'
import {
  chunkDetailResponseSchema,
  planTripSkeletonSchema,
  routeOutlineSchema,
  type ChunkDetailResponse,
  type PlanTripSkeleton,
  type PlanTripSkeletonDay,
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
  | { phase: 'outline' }
  | { phase: 'detail'; chunkIndex: number; chunkCount: number }

function stripCodeFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim()
}

export function parseRouteOutline(text: string): RouteOutline {
  return routeOutlineSchema.parse(JSON.parse(stripCodeFences(text)))
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
 * Plans a trip in two phases: a small "outline" call decides the whole
 * route's shape (which town each day overnights in, from the real start
 * point to the real end point) so pacing and the final destination are
 * solved with the whole trip in view, exactly as before. Then the route is
 * split into fixed-size chunks and each chunk's activities/restaurants are
 * filled in by a separate call that's given the full outline for context
 * but can only elaborate on its own days — it cannot redirect the route.
 * This keeps every individual call small regardless of trip length, unlike
 * asking for the whole detailed itinerary in one shot.
 */
export async function planTrip(input: {
  settings: TripSettings
  notesFreeText: string
  onProgress?: (progress: PlanTripProgress) => void
}): Promise<PlanTripSkeleton> {
  const client = new Anthropic({ apiKey: claudeApiKey.value() })

  input.onProgress?.({ phase: 'outline' })
  const { system: outlineSystem, user: outlineUser } = buildRouteOutlinePrompt(input)
  const outline = await callWithRetry(
    client,
    outlineSystem,
    outlineUser,
    8000,
    parseRouteOutline,
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
      activities: detail.activities,
      restaurants: detail.restaurants,
    }
  })

  return planTripSkeletonSchema.parse({ days })
}
