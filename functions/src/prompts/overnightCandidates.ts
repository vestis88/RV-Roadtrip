import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { defineSecret } from 'firebase-functions/params'
import type { LatLng, OvernightStopCandidate } from '@rv/shared'
import { logClaudeUsage } from '../claudeUsageLogger.js'
import {
  buildOvernightCandidatesPrompt,
  type ClaudeOvernightCandidateKind,
} from './overnightCandidatesPrompt.js'

export const claudeApiKey = defineSecret('CLAUDE_API_KEY')

const MODEL = 'claude-sonnet-5'
const MAX_ATTEMPTS = 2

const overnightCandidateResponseSchema = z.object({
  candidates: z
    .array(
      z.object({
        name: z.string(),
        lat: z.number(),
        lng: z.number(),
        description: z.string(),
      }),
    )
    .max(3),
})

function stripCodeFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim()
}

export function parseOvernightCandidatesResponse(text: string) {
  return overnightCandidateResponseSchema.parse(JSON.parse(stripCodeFences(text)))
}

function textFromResponse(response: Anthropic.Message): string {
  return response.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
}

/**
 * Stellplatz-fallback (only when OSM/Overpass has no nearby coverage) and
 * wild-camping candidates (implemented 2026-07-27): neither type has a
 * queryable structured database — Park4Night has no sanctioned API and
 * iOverlander's export is personal-use-only by its own terms, and wild
 * camping legality is a prose-law problem, not a POI-search problem — so
 * both are resolved via Claude + web search instead, grounded in the
 * country's already-gathered freeCampingRules where available.
 */
export async function generateClaudeOvernightCandidates(input: {
  kind: ClaudeOvernightCandidateKind
  near: LatLng
  country: string
  freeCampingRules?: string[]
  tripId?: string
}): Promise<OvernightStopCandidate[]> {
  const client = new Anthropic({ apiKey: claudeApiKey.value() })
  const { system, user } = buildOvernightCandidatesPrompt(input)
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: user }]

  let lastError: unknown
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let response: Anthropic.Message
    try {
      response = await client.messages.create({
        model: MODEL,
        max_tokens: 2000,
        thinking: { type: 'disabled' },
        system,
        messages,
        // Uncapped web_search bills every search result back in as input
        // tokens on top of the per-search fee — a single overnight-stop
        // lookup never legitimately needs more than a couple of searches.
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }],
      })
    } catch (error) {
      // A transient API-level failure, not malformed JSON — see
      // planTrip.ts's callWithRetry for why this needs its own retry too.
      lastError = error
      continue
    }
    logClaudeUsage({ callType: 'overnight', tripId: input.tripId, attempt, response })
    const text = textFromResponse(response)

    try {
      const parsed = parseOvernightCandidatesResponse(text)
      return parsed.candidates.map((candidate) => ({
        name: candidate.name,
        type: input.kind,
        lat: candidate.lat,
        lng: candidate.lng,
        country: input.country,
        description: candidate.description,
        source: 'claude' as const,
      }))
    } catch (error) {
      lastError = error
      messages.push({ role: 'assistant', content: text })
      messages.push({
        role: 'user',
        content: `Your last response failed validation: ${String(error)}. Return ONLY the corrected JSON matching the schema — no prose, no markdown code fences.`,
      })
    }
  }

  throw lastError
}
