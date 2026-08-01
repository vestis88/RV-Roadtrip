import { describe, expect, it, vi } from 'vitest'
import { parseOvernightCandidatesResponse } from './overnightCandidates.js'

const RECORDED_RESPONSE = `\`\`\`json
{
  "candidates": [
    { "name": "Riverside stopover", "lat": 61.2, "lng": 10.6, "description": "A well-documented free motorhome stop by the river." }
  ]
}
\`\`\``

describe('parseOvernightCandidatesResponse', () => {
  it('parses a recorded response', () => {
    const parsed = parseOvernightCandidatesResponse(RECORDED_RESPONSE)
    expect(parsed.candidates).toHaveLength(1)
    expect(parsed.candidates[0].name).toBe('Riverside stopover')
  })

  it('accepts an empty candidates list', () => {
    const parsed = parseOvernightCandidatesResponse('{"candidates": []}')
    expect(parsed.candidates).toHaveLength(0)
  })

  it('throws on a response missing required fields', () => {
    expect(() =>
      parseOvernightCandidatesResponse('{"candidates": [{"name": "x"}]}'),
    ).toThrow()
  })
})

const createMock = vi.fn()

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: createMock }
  },
}))

describe('generateClaudeOvernightCandidates', () => {
  it('tags results with the requested kind and source=claude, and offers web_search', async () => {
    createMock.mockReset()
    createMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: RECORDED_RESPONSE }],
    })

    const { generateClaudeOvernightCandidates } = await import(
      './overnightCandidates.js'
    )
    const candidates = await generateClaudeOvernightCandidates({
      kind: 'wild',
      near: { lat: 61.1, lng: 10.5 },
      country: 'NO',
      freeCampingRules: ['Allemannsretten allows free camping.'],
    })

    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({
      name: 'Riverside stopover',
      type: 'wild',
      country: 'NO',
      source: 'claude',
    })

    const [params] = createMock.mock.calls[0] as [
      { tools?: { type: string }[]; thinking?: { type: string } },
    ]
    expect(params.tools?.some((t) => t.type === 'web_search_20260209')).toBe(
      true,
    )
    expect(params.thinking).toEqual({ type: 'disabled' })
  })

  it('retries once on a schema failure and succeeds on the second attempt', async () => {
    createMock.mockReset()
    createMock
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'not valid json' }],
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: RECORDED_RESPONSE }],
      })

    const { generateClaudeOvernightCandidates } = await import(
      './overnightCandidates.js'
    )
    const candidates = await generateClaudeOvernightCandidates({
      kind: 'stellplatz',
      near: { lat: 61.1, lng: 10.5 },
      country: 'NO',
    })

    expect(createMock).toHaveBeenCalledTimes(2)
    expect(candidates[0].type).toBe('stellplatz')
  })

  // Regression: previously only a malformed-JSON response was retried — a
  // transient API-level failure (rate limit, brief overload, network blip)
  // propagated immediately with no retry at all.
  it('retries once on a transient API-level failure and succeeds on the second attempt', async () => {
    createMock.mockReset()
    createMock
      .mockRejectedValueOnce(new Error('529 overloaded_error'))
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: RECORDED_RESPONSE }],
      })

    const { generateClaudeOvernightCandidates } = await import(
      './overnightCandidates.js'
    )
    const candidates = await generateClaudeOvernightCandidates({
      kind: 'stellplatz',
      near: { lat: 61.1, lng: 10.5 },
      country: 'NO',
    })

    expect(createMock).toHaveBeenCalledTimes(2)
    expect(candidates[0].type).toBe('stellplatz')
  })
})
