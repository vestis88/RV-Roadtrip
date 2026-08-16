import Anthropic from '@anthropic-ai/sdk'
import { defineSecret } from 'firebase-functions/params'
import { z } from 'zod'
import type { CountryBriefSection, Vehicle } from '@rv/shared'
import { logClaudeUsage } from '../claudeUsageLogger.js'
import { extractJsonObject } from './jsonFromClaude.js'
import { runWebSearchTurn } from './webSearchTurn.js'

export const claudeApiKey = defineSecret('CLAUDE_API_KEY')

const MODEL = 'claude-sonnet-5'
const MAX_ATTEMPTS = 2
/**
 * Half of what the whole-guide prompt used to get, because this now runs
 * once per section rather than once for six of them — the per-call budget
 * shrinks even though the per-section depth doesn't.
 */
const MAX_WEB_SEARCHES = 4

const sectionOutputSchema = z.object({
  items: z.array(z.string()).min(1),
  sources: z.array(z.string()).default([]),
})

export function describeVehicle(vehicle: Vehicle): string {
  const parts = [`${vehicle.weightKg}kg`, `registered as a ${vehicle.registeredAs}`]
  if (vehicle.lengthM != null) parts.push(`${vehicle.lengthM}m long`)
  if (vehicle.heightM != null) parts.push(`${vehicle.heightM}m tall`)
  if (vehicle.widthM != null) parts.push(`${vehicle.widthM}m wide`)
  if (vehicle.fuel != null) parts.push(`${vehicle.fuel}-powered`)
  return parts.join(', ')
}

/**
 * One section, one prompt. The old prompt asked for all six topics and a
 * fixed JSON shape per topic, which is what made "add one more thing to
 * look up" impossible: the shape was the schema, so a seventh topic meant a
 * schema change, and any refresh re-researched all six.
 *
 * Here the section's own brief IS the instruction, and the output shape is
 * the same flat list of findings whatever the section asks for — so a
 * traveler-written section is a first-class citizen with no code change.
 * The vehicle is always described (a section can ask about it even when its
 * answer isn't cached per vehicle), and the date is always given so
 * anything time-sensitive can be hedged.
 */
export function buildCountrySectionPrompt(input: {
  countryCode: string
  countryName: string
  section: CountryBriefSection
  vehicle: Vehicle
  today: string
}): { system: string; user: string } {
  const system = `You are a European road-trip logistics expert advising RV travelers.

The traveler drives an RV: ${describeVehicle(input.vehicle)}.

Research exactly ONE topic for ${input.countryName} (${input.countryCode}), titled "${input.section.title}":

${input.section.brief}

Use your web search tool to find current, accurate information — fees, prices and rules change over time and must not be guessed from memory. Since they change, phrase anything time-sensitive cautiously, e.g. "As of ${input.today}, ...". Do not state a specific price or fee with confidence unless you found it via web search this session.

Answer only this topic. Do not cover other topics the traveler may have asked about separately.

Respond with JSON ONLY, matching this exact shape — no prose, no markdown code fences:
{
  "items": string[] (each a self-contained finding, phrased for someone reading it at the wheel),
  "sources": string[] (URLs you actually used; may be empty)
}`

  const user = JSON.stringify({
    countryCode: input.countryCode,
    country: input.countryName,
    topic: input.section.title,
    vehicle: input.vehicle,
    today: input.today,
  })

  return { system, user }
}

/** Tolerant of a sentence around the JSON — see jsonFromClaude.ts. */
export function parseCountrySectionOutput(text: string): {
  items: string[]
  sources: string[]
} {
  const json: unknown = JSON.parse(extractJsonObject(text))
  return sectionOutputSchema.parse(json)
}

function textFromResponse(response: Anthropic.Message): string {
  return response.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
}

export async function generateCountrySection(input: {
  countryCode: string
  countryName: string
  section: CountryBriefSection
  vehicle: Vehicle
  tripId?: string
}): Promise<{ items: string[]; sources: string[] }> {
  const client = new Anthropic({ apiKey: claudeApiKey.value() })
  const today = new Date().toISOString().slice(0, 10)
  const { system, user } = buildCountrySectionPrompt({ ...input, today })
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: user }]

  let lastError: unknown
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const attemptStartedAt = Date.now()
    try {
      const response: Anthropic.Message = await runWebSearchTurn(client, {
        model: MODEL,
        max_tokens: 2000,
        // Same reasoning as the guide prompt this replaces: schema-constrained
        // extraction, not open-ended reasoning.
        thinking: { type: 'disabled' },
        system,
        messages,
        tools: [
          {
            type: 'web_search_20260209',
            name: 'web_search',
            max_uses: MAX_WEB_SEARCHES,
          },
        ],
      })
      logClaudeUsage({
        callType: 'countryGuide',
        tripId: input.tripId,
        attempt,
        elapsedMs: Date.now() - attemptStartedAt,
        response,
      })
      return parseCountrySectionOutput(textFromResponse(response))
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}
