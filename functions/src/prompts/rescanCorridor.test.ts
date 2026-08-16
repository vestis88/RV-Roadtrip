import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseRescanResponse } from './rescanCorridor.js'

describe('parseRescanResponse', () => {
  it('parses a recorded response', () => {
    const parsed = parseRescanResponse(`\`\`\`json
{
  "finds": [
    { "name": "Lindesnes lighthouse", "country": "NO", "why": "Norway's southernmost point, recently reopened its visitor centre after a renovation." }
  ]
}
\`\`\``)
    expect(parsed.finds).toHaveLength(1)
    expect(parsed.finds[0].name).toBe('Lindesnes lighthouse')
  })

  it('accepts an empty finds list — "nothing nearby" is a real answer', () => {
    expect(parseRescanResponse('{"finds": []}').finds).toHaveLength(0)
  })

  it('throws on a response missing required fields', () => {
    expect(() => parseRescanResponse('{"finds": [{"name": "x"}]}')).toThrow()
  })
})

// Stubbed at `stream`, not `create`: a long web-search turn has to hold the
// connection open through the whole generation or it runs out the SDK's
// request timeout, so that is the call the code makes now. `createMock` still
// records the request params — every assertion about what was sent reads the
// same — and resolves what finalMessage() hands back.
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

const geocodeQueryMock = vi.fn()
vi.mock('../placesApi.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../placesApi.js')>()
  return {
    ...actual,
    geocodeQuery: (...args: unknown[]) => geocodeQueryMock(...args),
  }
})

function responseWithFinds(
  names: string[],
): { content: { type: string; text: string }[] } {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          finds: names.map((name) => ({
            name,
            country: 'NO',
            why: `Why ${name}.`,
          })),
        }),
      },
    ],
  }
}

const CENTER = { lat: 61.77, lng: 9.54 }

async function runRescan(radiusKm = 25) {
  const { generateRescanCandidates } = await import('./rescanCorridor.js')
  return generateRescanCandidates({
    center: CENTER,
    radiusKm,
    notesFreeText: 'We like hands-on museums.',
  })
}

describe('generateRescanCandidates', () => {
  it('offers web search and geocodes finds biased near the given center', async () => {
    createMock.mockReset().mockResolvedValueOnce(responseWithFinds(['Nearby']))
    geocodeQueryMock.mockReset().mockResolvedValue({ lat: 61.8, lng: 9.6 })

    const finds = await runRescan()

    expect(finds).toHaveLength(1)
    expect(finds[0]).toMatchObject({ name: 'Nearby', lat: 61.8, lng: 9.6 })
    expect(geocodeQueryMock).toHaveBeenCalledWith('Nearby, NO', CENTER)

    const [params] = createMock.mock.calls[0] as [
      { tools?: { type: string }[]; thinking?: { type: string }; system: string },
    ]
    expect(params.tools?.some((t) => t.type === 'web_search_20260209')).toBe(true)
    expect(params.thinking).toEqual({ type: 'disabled' })
    expect(params.system).toMatch(/DO NOT invent/i)
  })

  // "Describe what you want" (AddCorridorStopForm, 2026-08-01): a traveler
  // query narrows what this same call looks for instead of the generic
  // "what's worth stopping for" pass.
  it('includes the traveler\'s query as a focusQuery when one is given', async () => {
    createMock.mockReset().mockResolvedValueOnce(responseWithFinds(['Nearby']))
    geocodeQueryMock.mockReset().mockResolvedValue({ lat: 61.8, lng: 9.6 })

    const { generateRescanCandidates } = await import('./rescanCorridor.js')
    await generateRescanCandidates({
      center: CENTER,
      radiusKm: 25,
      query: 'coffee stop',
    })

    const [params] = createMock.mock.calls[0] as [
      { messages: { content: string }[] },
    ]
    const userContent = JSON.parse(params.messages[0].content) as Record<
      string,
      unknown
    >
    expect(userContent.focusQuery).toBe('coffee stop')
  })

  it('omits focusQuery entirely from a plain rescan with no query', async () => {
    createMock.mockReset().mockResolvedValueOnce(responseWithFinds(['Nearby']))
    geocodeQueryMock.mockReset().mockResolvedValue({ lat: 61.8, lng: 9.6 })

    await runRescan()

    const [params] = createMock.mock.calls[0] as [
      { messages: { content: string }[] },
    ]
    const userContent = JSON.parse(params.messages[0].content) as Record<
      string,
      unknown
    >
    expect(userContent).not.toHaveProperty('focusQuery')
  })

  // Route-aware search (2026-08-01, following user feedback that "along
  // route" should mean the actual explore-mode corridor, not just wherever
  // the map happens to be panned): when `backbone` is given, filtering
  // switches from distance-off-center to detour-off-backbone.
  it('filters by detour off the route backbone instead of distance from center when backbone is given', async () => {
    createMock
      .mockReset()
      .mockResolvedValueOnce(responseWithFinds(['OnRoute', 'OffRoute']))
    geocodeQueryMock.mockReset().mockImplementation((query: string) =>
      Promise.resolve(
        query.startsWith('OnRoute')
          ? { lat: 61.5, lng: 9.0 } // roughly on the backbone line below
          : { lat: 61.5, lng: 12.0 }, // ~150km east of it
      ),
    )

    const { generateRescanCandidates } = await import('./rescanCorridor.js')
    const finds = await generateRescanCandidates({
      // Deliberately far from both finds and a tiny radius — proves the
      // center/radiusKm pair isn't what's doing the filtering here.
      center: { lat: 0, lng: 0 },
      radiusKm: 1,
      backbone: [
        { lat: 61.0, lng: 9.0 },
        { lat: 62.0, lng: 9.0 },
      ],
    })

    expect(finds.map((f) => f.name)).toEqual(['OnRoute'])
  })

  it('sends routeWaypoints instead of areaDescription/radiusKm in the prompt when backbone is given', async () => {
    createMock.mockReset().mockResolvedValueOnce(responseWithFinds([]))
    geocodeQueryMock.mockReset()

    const { generateRescanCandidates } = await import('./rescanCorridor.js')
    await generateRescanCandidates({
      center: CENTER,
      radiusKm: 25,
      backbone: [
        { lat: 61.0, lng: 9.0 },
        { lat: 62.0, lng: 9.0 },
      ],
    })

    const [params] = createMock.mock.calls[0] as [
      { messages: { content: string }[] },
    ]
    const userContent = JSON.parse(params.messages[0].content) as Record<
      string,
      unknown
    >
    expect(userContent).toHaveProperty('routeWaypoints')
    expect(userContent).not.toHaveProperty('areaDescription')
    expect(userContent).not.toHaveProperty('radiusKm')
  })

  // A search the traveler didn't phrase geographically ("what's worth
  // stopping for here") used to anchor on nothing but a pair of decimals.
  // Note this is NOT the fix for the reported Hillerød timeout — that query
  // named its own town and still failed; see querySearch.ts.
  it('names the area instead of sending coordinates when centerName is given', async () => {
    createMock.mockReset().mockResolvedValueOnce(responseWithFinds([]))
    geocodeQueryMock.mockReset()

    const { generateRescanCandidates } = await import('./rescanCorridor.js')
    await generateRescanCandidates({
      center: CENTER,
      radiusKm: 25,
      centerName: 'Hillerød, Denmark',
      query: 'a cozy restaurant',
    })

    const [params] = createMock.mock.calls[0] as [
      { messages: { content: string }[] },
    ]
    const userContent = JSON.parse(params.messages[0].content) as Record<
      string,
      unknown
    >
    expect(userContent.areaDescription).toBe('Hillerød, Denmark')
    expect(JSON.stringify(userContent)).not.toContain('latitude')
  })

  it('names the corridor instead of listing latitudes when waypointNames are given', async () => {
    createMock.mockReset().mockResolvedValueOnce(responseWithFinds([]))
    geocodeQueryMock.mockReset()

    const { generateRescanCandidates } = await import('./rescanCorridor.js')
    await generateRescanCandidates({
      center: CENTER,
      radiusKm: 25,
      backbone: [
        { lat: 61.0, lng: 9.0 },
        { lat: 62.0, lng: 9.0 },
      ],
      waypointNames: ['Oslo, Norway', 'Otta, Norway', 'Trondheim, Norway'],
    })

    const [params] = createMock.mock.calls[0] as [
      { messages: { content: string }[] },
    ]
    const userContent = JSON.parse(params.messages[0].content) as Record<
      string,
      unknown
    >
    expect(userContent.routeWaypoints).toEqual([
      'Oslo, Norway',
      'Otta, Norway',
      'Trondheim, Norway',
    ])
    expect(JSON.stringify(userContent)).not.toContain('latitude')
  })

  // Reverse geocoding is best-effort on the client, so the coordinate form
  // has to keep working — worse prompt, but never a broken one.
  it('still falls back to coordinates when no names are available', async () => {
    createMock.mockReset().mockResolvedValueOnce(responseWithFinds([]))
    geocodeQueryMock.mockReset()

    const { generateRescanCandidates } = await import('./rescanCorridor.js')
    await generateRescanCandidates({ center: CENTER, radiusKm: 25 })

    const [params] = createMock.mock.calls[0] as [
      { messages: { content: string }[] },
    ]
    const userContent = JSON.parse(params.messages[0].content) as Record<
      string,
      unknown
    >
    expect(String(userContent.areaDescription)).toContain('latitude')
  })

  it('falls back to distance-from-center filtering when backbone has fewer than 2 points', async () => {
    createMock.mockReset().mockResolvedValueOnce(responseWithFinds(['Nearby']))
    geocodeQueryMock.mockReset().mockResolvedValue({ lat: 61.8, lng: 9.6 })

    const { generateRescanCandidates } = await import('./rescanCorridor.js')
    const finds = await generateRescanCandidates({
      center: CENTER,
      radiusKm: 25,
      backbone: [{ lat: 61.0, lng: 9.0 }],
    })

    expect(finds).toHaveLength(1)
    const [params] = createMock.mock.calls[0] as [
      { messages: { content: string }[] },
    ]
    const userContent = JSON.parse(params.messages[0].content) as Record<
      string,
      unknown
    >
    expect(userContent).toHaveProperty('areaDescription')
  })

  it('drops a find outside the requested radius', async () => {
    createMock
      .mockReset()
      .mockResolvedValueOnce(responseWithFinds(['Close', 'Far']))
    geocodeQueryMock
      .mockReset()
      .mockImplementation((query: string) =>
        Promise.resolve(
          query.startsWith('Far')
            ? { lat: 63, lng: 9.54 } // ~137 km away
            : { lat: 61.8, lng: 9.6 }, // a few km away
        ),
      )

    const finds = await runRescan(25)

    expect(finds.map((f) => f.name)).toEqual(['Close'])
  })

  it('drops a find that never geocoded rather than letting it through unchecked', async () => {
    createMock
      .mockReset()
      .mockResolvedValueOnce(responseWithFinds(['Close', 'Unlocatable']))
    geocodeQueryMock
      .mockReset()
      .mockImplementation((query: string) =>
        Promise.resolve(
          query.startsWith('Unlocatable') ? null : { lat: 61.8, lng: 9.6 },
        ),
      )

    const finds = await runRescan()

    expect(finds.map((f) => f.name)).toEqual(['Close'])
  })

  it('caps results at MAX_RESCAN_RESULTS', async () => {
    const { MAX_RESCAN_RESULTS } = await import('./rescanCorridor.js')
    const names = Array.from({ length: MAX_RESCAN_RESULTS + 5 }, (_, i) => `Stop ${i}`)
    createMock.mockReset().mockResolvedValueOnce(responseWithFinds(names))
    geocodeQueryMock.mockReset().mockResolvedValue({ lat: 61.8, lng: 9.6 })

    const finds = await runRescan()

    expect(finds).toHaveLength(MAX_RESCAN_RESULTS)
  })

  it('returns nothing when the search itself found nothing', async () => {
    createMock.mockReset().mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"finds": []}' }],
    })
    geocodeQueryMock.mockReset()

    expect(await runRescan()).toEqual([])
    expect(geocodeQueryMock).not.toHaveBeenCalled()
  })

  it('retries once on a schema failure and succeeds on the second attempt', async () => {
    createMock
      .mockReset()
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'not valid json' }] })
      .mockResolvedValueOnce(responseWithFinds(['Nearby']))
    geocodeQueryMock.mockReset().mockResolvedValue({ lat: 61.8, lng: 9.6 })

    const finds = await runRescan()

    expect(createMock).toHaveBeenCalledTimes(2)
    expect(finds[0].name).toBe('Nearby')
  })

  it('throws when every attempt fails validation, leaving the caller to decide', async () => {
    createMock
      .mockReset()
      .mockResolvedValue({ content: [{ type: 'text', text: 'still not json' }] })
    geocodeQueryMock.mockReset()

    await expect(runRescan()).rejects.toBeDefined()
    expect(createMock).toHaveBeenCalledTimes(2)
  })

  // Regression: the retry loop previously only caught a malformed-JSON
  // response — a transient API-level failure (rate limit, brief overload,
  // network blip) from the client.messages.create call itself propagated
  // immediately with no retry at all, defeating the whole point of
  // MAX_ATTEMPTS. Reported as "rescan doesn't work" on what was very
  // plausibly just an ordinary transient hiccup.
  it('retries once on a transient API-level failure and succeeds on the second attempt', async () => {
    createMock
      .mockReset()
      .mockRejectedValueOnce(new Error('529 overloaded_error'))
      .mockResolvedValueOnce(responseWithFinds(['Nearby']))
    geocodeQueryMock.mockReset().mockResolvedValue({ lat: 61.8, lng: 9.6 })

    const finds = await runRescan()

    expect(createMock).toHaveBeenCalledTimes(2)
    expect(finds[0].name).toBe('Nearby')
  })

  it('throws the transient-failure error when every attempt fails at the API level', async () => {
    createMock.mockReset().mockRejectedValue(new Error('529 overloaded_error'))
    geocodeQueryMock.mockReset()

    await expect(runRescan()).rejects.toThrow('529 overloaded_error')
    expect(createMock).toHaveBeenCalledTimes(2)
  })
})

describe('generateRescanCandidates — long and paused turns', () => {
  const NEAR = { lat: 61.1, lng: 10.5 }

  beforeEach(() => {
    vi.stubEnv('CLAUDE_API_KEY', 'test-key')
    geocodeQueryMock.mockReset().mockResolvedValue({ lat: 61.2, lng: 10.6 })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('streams the search rather than waiting on one whole request', async () => {
    // The non-streaming path is what a three-web-search turn runs out of.
    // Asserting the call shape is the only way to pin this from a unit test:
    // the timeout it prevents lives in the SDK's transport, not in our code.
    createMock.mockReset().mockResolvedValueOnce(responseWithFinds(['Nearby']))

    const { generateRescanCandidates } = await import('./rescanCorridor.js')
    await generateRescanCandidates({ center: NEAR, radiusKm: 25 })

    expect(createMock).toHaveBeenCalledTimes(1)
  })

  // A server-side tool runs inside its own sampling loop; hitting that loop's
  // ceiling ends the turn with `pause_turn` and a partial answer. That used
  // to reach the schema parser as though it were a finished response — the
  // JSON was cut off, parsing failed, and a merely unfinished search was
  // reported as a malformed one.
  it('resumes a paused turn instead of parsing the partial answer', async () => {
    createMock
      .mockReset()
      .mockResolvedValueOnce({
        stop_reason: 'pause_turn',
        content: [{ type: 'text', text: '{"finds": [' }],
      })
      .mockResolvedValueOnce(responseWithFinds(['Nearby']))

    const { generateRescanCandidates } = await import('./rescanCorridor.js')
    const finds = await generateRescanCandidates({ center: NEAR, radiusKm: 25 })

    expect(createMock).toHaveBeenCalledTimes(2)
    expect(finds.map((find) => find.name)).toEqual(['Nearby'])
  })

  // Continuing a paused turn means re-sending the conversation with the
  // partial assistant turn appended and nothing else. A "carry on" message
  // would read as a fresh instruction rather than a continuation.
  it('resumes by appending the partial turn, with no extra instruction', async () => {
    createMock
      .mockReset()
      .mockResolvedValueOnce({
        stop_reason: 'pause_turn',
        content: [{ type: 'text', text: '{"finds": [' }],
      })
      .mockResolvedValueOnce(responseWithFinds(['Nearby']))

    const { generateRescanCandidates } = await import('./rescanCorridor.js')
    await generateRescanCandidates({ center: NEAR, radiusKm: 25 })

    const [resumed] = createMock.mock.calls[1] as [
      { messages: { role: string }[] },
    ]
    expect(resumed.messages).toHaveLength(2)
    expect(resumed.messages[1].role).toBe('assistant')
  })

  it('gives up resuming rather than spinning until the deadline kills it', async () => {
    createMock.mockReset().mockResolvedValue({
      stop_reason: 'pause_turn',
      content: [{ type: 'text', text: '{"finds": []}' }],
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { generateRescanCandidates } = await import('./rescanCorridor.js')
    await generateRescanCandidates({ center: NEAR, radiusKm: 25 })

    // Four calls: the first turn plus MAX_PAUSE_RESUMES resumes. Anything
    // unbounded here would burn the whole function budget on one attempt.
    expect(createMock).toHaveBeenCalledTimes(4)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('generateRescanCandidates — staying inside the caller\'s budget', () => {
  const NEAR = { lat: 61.1, lng: 10.5 }

  beforeEach(() => {
    vi.stubEnv('CLAUDE_API_KEY', 'test-key')
    geocodeQueryMock.mockReset().mockResolvedValue({ lat: 61.2, lng: 10.6 })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  // The reported failure: "Scanning… 5m 4s", then an error — the function's
  // own 300s ceiling to the second. A rescan is the only search here that
  // uses web_search, so each turn costs a minute or more; two attempts of up
  // to four turns each is eight searching turns, which no deadline survives.
  // Counting attempts was the wrong bound. Time is the right one.
  it('does not start a turn it has no time to finish', async () => {
    createMock.mockReset().mockResolvedValue({
      stop_reason: 'pause_turn',
      content: [{ type: 'text', text: '{"finds": []}' }],
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { generateRescanCandidates } = await import('./rescanCorridor.js')
    await generateRescanCandidates({
      center: NEAR,
      radiusKm: 25,
      // Already spent: there is room for the first turn and nothing after it.
      deadlineMs: Date.now() + 1_000,
    })

    // One turn, no resumes — the resume cap would have allowed three more.
    expect(createMock).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('no time left to resume'),
    )
    warn.mockRestore()
  })

  it('still resumes when there is budget for it', async () => {
    createMock
      .mockReset()
      .mockResolvedValueOnce({
        stop_reason: 'pause_turn',
        content: [{ type: 'text', text: '{"finds": [' }],
      })
      .mockResolvedValueOnce(responseWithFinds(['Nearby']))

    const { generateRescanCandidates } = await import('./rescanCorridor.js')
    const finds = await generateRescanCandidates({
      center: NEAR,
      radiusKm: 25,
      deadlineMs: Date.now() + 10 * 60_000,
    })

    expect(createMock).toHaveBeenCalledTimes(2)
    expect(finds.map((find) => find.name)).toEqual(['Nearby'])
  })

  // A short budget must not cost the traveler the finds already in hand —
  // being killed at the deadline with everything discarded is the failure
  // this replaces.
  it('returns what it found rather than nothing when the budget runs out', async () => {
    createMock.mockReset().mockResolvedValueOnce(responseWithFinds(['Nearby']))

    const { generateRescanCandidates } = await import('./rescanCorridor.js')
    const finds = await generateRescanCandidates({
      center: NEAR,
      radiusKm: 25,
      deadlineMs: Date.now() + 1_000,
    })

    expect(finds.map((find) => find.name)).toEqual(['Nearby'])
  })
})

/**
 * The reported failure, over and over: "it scanned for minutes and came up
 * empty", and then "it still shouldn't be that long and come up empty!!".
 *
 * The search had done the expensive part. What it hadn't done was get the
 * JSON out — paused, clipped by the deadline, or cut off at max_tokens
 * mid-object — and every one of those went straight to JSON.parse, threw,
 * and discarded the entire run. The traveler paid for a search that had
 * genuinely found places and was told nothing was found.
 */
describe('generateRescanCandidates — an answer for a search that already happened', () => {
  const NEAR = { lat: 61.1, lng: 10.5 }

  beforeEach(() => {
    vi.stubEnv('CLAUDE_API_KEY', 'test-key')
    geocodeQueryMock.mockReset().mockResolvedValue({ lat: 61.2, lng: 10.6 })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  /** A turn that ran its web searches, however it then ended. */
  function searchedTurn(text: string, stopReason?: string) {
    return {
      ...(stopReason ? { stop_reason: stopReason } : {}),
      content: [
        { type: 'web_search_tool_result', content: [] },
        ...(text ? [{ type: 'text', text }] : []),
      ],
    }
  }

  it('asks for the write-up without searching again when a turn is cut off mid-answer', async () => {
    createMock
      .mockReset()
      .mockResolvedValueOnce(searchedTurn('{"finds": [{"name": "Nea', 'max_tokens'))
      .mockResolvedValueOnce(responseWithFinds(['Nearby']))

    const { generateRescanCandidates } = await import('./rescanCorridor.js')
    const finds = await generateRescanCandidates({ center: NEAR, radiusKm: 25 })

    expect(finds.map((find) => find.name)).toEqual(['Nearby'])
    const [finalize] = createMock.mock.calls[1] as [
      {
        tool_choice?: { type: string }
        messages: { role: string; content: unknown }[]
      },
    ]
    // The whole point: no second search. The tools stay declared so the
    // search blocks already in the history remain valid.
    expect(finalize.tool_choice).toEqual({ type: 'none' })
    expect(finalize.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
    ])
  })

  it('recovers a turn that searched and then produced no text at all', async () => {
    createMock
      .mockReset()
      .mockResolvedValueOnce(searchedTurn('', 'pause_turn'))
      .mockResolvedValueOnce(searchedTurn('', 'pause_turn'))
      .mockResolvedValueOnce(searchedTurn('', 'pause_turn'))
      .mockResolvedValueOnce(searchedTurn('', 'pause_turn'))
      .mockResolvedValueOnce(responseWithFinds(['Nearby']))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { generateRescanCandidates } = await import('./rescanCorridor.js')
    const finds = await generateRescanCandidates({ center: NEAR, radiusKm: 25 })

    expect(finds.map((find) => find.name)).toEqual(['Nearby'])
    warn.mockRestore()
  })

  // An assistant turn with empty content is rejected outright by the API, so
  // quoting an empty response back at Claude turned "the model returned no
  // text" into a 400 on the very attempt meant to recover from it — a
  // different and more confusing failure than the one that happened.
  it('never quotes an empty response back on the retry', async () => {
    createMock.mockReset().mockResolvedValue({ content: [] })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { generateRescanCandidates } = await import('./rescanCorridor.js')
    await expect(
      generateRescanCandidates({ center: NEAR, radiusKm: 25 }),
    ).rejects.toThrow(/no answer at all/i)

    for (const [params] of createMock.mock.calls as [
      { messages: { role: string; content: unknown }[] },
    ][]) {
      expect(params.messages.some((m) => m.content === '')).toBe(false)
    }
    warn.mockRestore()
  })

  // "Unexpected end of JSON input" reads as Claude returning malformed JSON,
  // which is a prompt problem. Running out of output length is not. Those
  // have different fixes, and the wrong one was the only thing on screen.
  it('reports a truncated answer as truncated, not as malformed JSON', async () => {
    createMock
      .mockReset()
      .mockResolvedValue(searchedTurn('{"finds": [{"name": "Nea', 'max_tokens'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { generateRescanCandidates } = await import('./rescanCorridor.js')
    await expect(
      generateRescanCandidates({ center: NEAR, radiusKm: 25 }),
    ).rejects.toThrow(/cut off/i)
    warn.mockRestore()
  })

  // The finalize turn is only ever reached when the alternative is throwing,
  // so its own failure must restore that outcome rather than replace it.
  it('falls back to the ordinary retry when the finalize turn itself fails', async () => {
    createMock
      .mockReset()
      .mockResolvedValueOnce(searchedTurn('not json', 'end_turn'))
      .mockRejectedValueOnce(new Error('529 overloaded_error'))
      .mockResolvedValueOnce(responseWithFinds(['Nearby']))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { generateRescanCandidates } = await import('./rescanCorridor.js')
    const finds = await generateRescanCandidates({ center: NEAR, radiusKm: 25 })

    expect(finds.map((find) => find.name)).toEqual(['Nearby'])
    warn.mockRestore()
  })
})
