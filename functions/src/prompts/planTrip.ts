import Anthropic from '@anthropic-ai/sdk'
import { defineSecret } from 'firebase-functions/params'
import type { TripSettings } from '@rv/shared'
import { buildPlanTripPrompt } from './planTripPrompt.js'
import { planTripSkeletonSchema, type PlanTripSkeleton } from './planTripSchema.js'

export const claudeApiKey = defineSecret('CLAUDE_API_KEY')

const MODEL = 'claude-sonnet-4-6'
const MAX_ATTEMPTS = 2

function stripCodeFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim()
}

export function parsePlanTripSkeleton(text: string): PlanTripSkeleton {
  const json: unknown = JSON.parse(stripCodeFences(text))
  return planTripSkeletonSchema.parse(json)
}

function textFromResponse(response: Anthropic.Message): string {
  return response.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
}

export async function planTrip(input: {
  settings: TripSettings
  notesFreeText: string
}): Promise<PlanTripSkeleton> {
  const client = new Anthropic({ apiKey: claudeApiKey.value() })
  const { system, user } = buildPlanTripPrompt(input)
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: user }]

  let lastError: unknown
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 8000,
      system,
      messages,
    })
    const text = textFromResponse(response)

    try {
      return parsePlanTripSkeleton(text)
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
