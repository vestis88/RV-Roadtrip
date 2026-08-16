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

// Stubbed at `stream`, not `create`: a searching turn has to hold the
// connection open through the whole generation or it runs out the SDK's
// request timeout, so that is the call this code makes now (see
// webSearchTurn.ts). `createMock` still records the request params — every
// assertion about what was sent reads the same — and resolves what
// finalMessage() hands back.
const createMock = vi.fn()

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      stream: (params: unknown) => ({
        finalMessage: () => createMock(params),
      }),
    }
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

  // Regression: Claude has no geocode step to fall back on for these two
  // candidate types (no queryable database to check its coordinates
  // against), so a hallucinated lat/lng far from the requested point
  // previously went straight to the traveler as a legitimate "nearby"
  // option.
  it('drops a candidate whose coordinates are implausibly far from the requested point', async () => {
    createMock.mockReset()
    createMock.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            candidates: [
              // ~5km from near — plausible.
              { name: 'Nearby stop', lat: 61.15, lng: 10.55, description: 'Close by.' },
              // Rome, nowhere near a Lillehammer-area search — a
              // hallucinated/wrong coordinate.
              { name: 'Hallucinated stop', lat: 41.9, lng: 12.5, description: 'Far away.' },
            ],
          }),
        },
      ],
    })

    const { generateClaudeOvernightCandidates } = await import(
      './overnightCandidates.js'
    )
    const candidates = await generateClaudeOvernightCandidates({
      kind: 'wild',
      near: { lat: 61.1, lng: 10.5 },
      country: 'NO',
    })

    expect(candidates.map((c) => c.name)).toEqual(['Nearby stop'])
  })
})

/**
 * Free camping and the Stellplatz fallback are the two calls that still
 * legitimately use web search — there is no queryable database for either
 * (Park4Night has no sanctioned API, iOverlander's export is personal-use
 * only) and wild-camping legality is prose law, not a POI lookup. What they
 * never had was any of the robustness a searching turn needs. The rescan
 * path spent weeks failing for exactly these three gaps before they were
 * found; these are the same gaps, in the code that still searches.
 */
describe('generateClaudeOvernightCandidates — surviving a searching turn', () => {
  const NEAR = { lat: 59.33, lng: 18.06 }

  function run() {
    return import('./overnightCandidates.js').then(
      ({ generateClaudeOvernightCandidates }) =>
        generateClaudeOvernightCandidates({
          kind: 'wild',
          near: NEAR,
          country: 'SE',
        }),
    )
  }

  function answer(name: string) {
    return {
      content: [
        { type: 'web_search_tool_result', content: [] },
        {
          type: 'text',
          text: JSON.stringify({
            candidates: [
              {
                name,
                lat: NEAR.lat,
                lng: NEAR.lng,
                description: 'Allemansrätten applies here.',
              },
            ],
          }),
        },
      ],
    }
  }

  it('streams rather than waiting on one whole request', async () => {
    createMock.mockReset().mockResolvedValueOnce(answer('Lakeside pull-in'))

    const candidates = await run()

    expect(candidates.map((c) => c.name)).toEqual(['Lakeside pull-in'])
    expect(createMock).toHaveBeenCalledTimes(1)
  })

  // A server tool runs inside Anthropic's own sampling loop; hitting its
  // ceiling ends the turn with a partial answer. Parsed as though finished,
  // that is a guaranteed failure reported as malformed JSON — and the retry
  // then pays for a whole second set of searches.
  it('resumes a paused turn instead of parsing the partial answer', async () => {
    createMock
      .mockReset()
      .mockResolvedValueOnce({
        stop_reason: 'pause_turn',
        content: [{ type: 'text', text: '{"candidates": [' }],
      })
      .mockResolvedValueOnce(answer('Forest track'))

    const candidates = await run()

    expect(candidates.map((c) => c.name)).toEqual(['Forest track'])
    const [resumed] = createMock.mock.calls[1] as [
      { messages: { role: string }[] },
    ]
    expect(resumed.messages).toHaveLength(2)
    expect(resumed.messages[1].role).toBe('assistant')
  })

  it('reads an answer with a sentence around it rather than discarding it', async () => {
    const good = answer('Gravel clearing')
    const text = (good.content[1] as { text: string }).text
    createMock.mockReset().mockResolvedValueOnce({
      content: [
        { type: 'web_search_tool_result', content: [] },
        {
          type: 'text',
          text: `Based on my searches of Swedish allemansrätten:\n\n${text}\n\nLet me know if you want more options.`,
        },
      ],
    })

    expect((await run()).map((c) => c.name)).toEqual(['Gravel clearing'])
    // The whole point: one set of searches, not a retry to say it again.
    expect(createMock).toHaveBeenCalledTimes(1)
  })

  it('never quotes an empty response back on the retry', async () => {
    createMock.mockReset().mockResolvedValue({ content: [] })

    await expect(run()).rejects.toBeDefined()

    for (const [params] of createMock.mock.calls as [
      { messages: { content: unknown }[] },
    ][]) {
      expect(params.messages.some((m) => m.content === '')).toBe(false)
    }
  })
})
