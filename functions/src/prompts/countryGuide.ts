import Anthropic from '@anthropic-ai/sdk'
import { defineSecret } from 'firebase-functions/params'
import { countryGuideSchema, type CountryGuide, type Vehicle } from '@rv/shared'
import { buildCountryGuidePrompt } from './countryGuidePrompt.js'

export const claudeApiKey = defineSecret('CLAUDE_API_KEY')

const MODEL = 'claude-sonnet-4-6'
const MAX_ATTEMPTS = 2

const countryGuideOutputSchema = countryGuideSchema.omit({ generatedAt: true })

function stripCodeFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim()
}

export function parseCountryGuideOutput(
  text: string,
): Omit<CountryGuide, 'generatedAt'> {
  const json: unknown = JSON.parse(stripCodeFences(text))
  return countryGuideOutputSchema.parse(json)
}

function textFromResponse(response: Anthropic.Message): string {
  return response.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
}

export async function generateCountryGuide(input: {
  countryCode: string
  vehicle: Vehicle
}): Promise<CountryGuide> {
  const client = new Anthropic({ apiKey: claudeApiKey.value() })
  const today = new Date().toISOString().slice(0, 10)
  const { system, user } = buildCountryGuidePrompt({ ...input, today })
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: user }]

  let lastError: unknown
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      system,
      messages,
      tools: [{ type: 'web_search_20260209', name: 'web_search' }],
    })
    const text = textFromResponse(response)

    try {
      const parsed = parseCountryGuideOutput(text)
      return { ...parsed, generatedAt: new Date().toISOString() }
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
