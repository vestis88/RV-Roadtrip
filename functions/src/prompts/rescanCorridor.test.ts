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

// The seam is verifyPlaceLocation, not geocodeQuery: a find is checked for
// identity and comes back with Places' OWN name and listing URL, which is
// the whole point (a card read "Vrå Bike Park" over a pin sitting on
// Vallåsen Bike Park, because the verified name was thrown away).
const verifyPlaceMock = vi.fn()
vi.mock('../placesApi.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../placesApi.js')>()
  return {
    ...actual,
    verifyPlaceLocation: (...args: unknown[]) => verifyPlaceMock(...args),
  }
})

/** Places confirming the name it was asked for, at a given point. */
function found(point: { lat: number; lng: number }) {
  return (_query: string, expectedName: string) =>
    Promise.resolve({ name: expectedName, ...point })
}

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
  // No tools, deliberately. The web_search tool was what made this call take
  // minutes, and its "ground every suggestion in something you found via web
  // search" rule was what made it answer "nothing nearby" for an area with a
  // bike park in it. Grounding is the Places lookup below, which is the same
  // check the whole-trip curation phase relies on — and that phase calls
  // Claude with no tools at all.
  it('asks Claude directly, with no tools, and verifies each find through Places', async () => {
    createMock.mockReset().mockResolvedValueOnce(responseWithFinds(['Nearby']))
    verifyPlaceMock.mockReset().mockImplementation(found({ lat: 61.8, lng: 9.6 }))

    const finds = await runRescan()

    expect(finds).toHaveLength(1)
    expect(finds[0]).toMatchObject({ name: 'Nearby', lat: 61.8, lng: 9.6 })
    expect(verifyPlaceMock).toHaveBeenCalledWith(
      'Nearby, NO',
      'Nearby',
      CENTER,
      Number.POSITIVE_INFINITY,
    )

    const [params] = createMock.mock.calls[0] as [
      { tools?: unknown; thinking?: { type: string }; system: string },
    ]
    expect(params.tools).toBeUndefined()
    expect(params.thinking).toEqual({ type: 'disabled' })
    expect(params.system).toMatch(/DO NOT invent/i)
  })

  // The defect behind "Nothing new found nearby" on a downhill-biking trip
  // with Vallåsen Bike Park inside the searched circle: this prompt received
  // the freeform notes and never the interests, so it answered a different
  // question from the one the traveler thought they were asking.
  it("sends the trip's stated interests, not just the freeform notes", async () => {
    createMock.mockReset().mockResolvedValueOnce(responseWithFinds([]))
    verifyPlaceMock.mockReset()

    const { generateRescanCandidates } = await import('./rescanCorridor.js')
    await generateRescanCandidates({
      center: CENTER,
      radiusKm: 25,
      interests: ['downhill mountain biking', 'swimming'],
      notesFreeText: 'cozy over mainstream',
    })

    const [params] = createMock.mock.calls[0] as [
      { messages: { content: string }[] },
    ]
    const userContent = JSON.parse(params.messages[0].content) as Record<
      string,
      unknown
    >
    expect(userContent.interests).toEqual([
      'downhill mountain biking',
      'swimming',
    ])
    expect(userContent.notes).toBe('cozy over mainstream')
  })

  it('includes the traveler\'s query as a focusQuery when one is given', async () => {
    createMock.mockReset().mockResolvedValueOnce(responseWithFinds(['Nearby']))
    verifyPlaceMock.mockReset().mockImplementation(found({ lat: 61.8, lng: 9.6 }))

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
    verifyPlaceMock.mockReset().mockImplementation(found({ lat: 61.8, lng: 9.6 }))

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
    verifyPlaceMock.mockReset().mockImplementation((query: string, expectedName: string) =>
      Promise.resolve({
        name: expectedName,
        ...(query.startsWith('OnRoute')
          ? { lat: 61.5, lng: 9.0 } // roughly on the backbone line below
          : { lat: 61.5, lng: 12.0 }), // ~150km east of it
      }),
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
    verifyPlaceMock.mockReset()

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
    verifyPlaceMock.mockReset()

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
    verifyPlaceMock.mockReset()

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
    verifyPlaceMock.mockReset()

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
    verifyPlaceMock.mockReset().mockImplementation(found({ lat: 61.8, lng: 9.6 }))

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
    verifyPlaceMock
      .mockReset()
      .mockImplementation((query: string, expectedName: string) =>
        Promise.resolve({
          name: expectedName,
          ...(query.startsWith('Far')
            ? { lat: 63, lng: 9.54 } // ~137 km away
            : { lat: 61.8, lng: 9.6 }), // a few km away
        }),
      )

    const finds = await runRescan(25)

    expect(finds.map((f) => f.name)).toEqual(['Close'])
  })

  it('drops a find that never geocoded rather than letting it through unchecked', async () => {
    createMock
      .mockReset()
      .mockResolvedValueOnce(responseWithFinds(['Close', 'Unlocatable']))
    verifyPlaceMock
      .mockReset()
      .mockImplementation((query: string, expectedName: string) =>
        Promise.resolve(
          query.startsWith('Unlocatable')
            ? null
            : { name: expectedName, lat: 61.8, lng: 9.6 },
        ),
      )

    const finds = await runRescan()

    expect(finds.map((f) => f.name)).toEqual(['Close'])
  })

  it('caps results at MAX_RESCAN_RESULTS', async () => {
    const { MAX_RESCAN_RESULTS } = await import('./rescanCorridor.js')
    const names = Array.from({ length: MAX_RESCAN_RESULTS + 5 }, (_, i) => `Stop ${i}`)
    createMock.mockReset().mockResolvedValueOnce(responseWithFinds(names))
    verifyPlaceMock.mockReset().mockImplementation(found({ lat: 61.8, lng: 9.6 }))

    const finds = await runRescan()

    expect(finds).toHaveLength(MAX_RESCAN_RESULTS)
  })

  it('returns nothing when the search itself found nothing', async () => {
    createMock.mockReset().mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"finds": []}' }],
    })
    verifyPlaceMock.mockReset()

    expect(await runRescan()).toEqual([])
    expect(verifyPlaceMock).not.toHaveBeenCalled()
  })

  it('retries once on a schema failure and succeeds on the second attempt', async () => {
    createMock
      .mockReset()
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'not valid json' }] })
      .mockResolvedValueOnce(responseWithFinds(['Nearby']))
    verifyPlaceMock.mockReset().mockImplementation(found({ lat: 61.8, lng: 9.6 }))

    const finds = await runRescan()

    expect(createMock).toHaveBeenCalledTimes(2)
    expect(finds[0].name).toBe('Nearby')
  })

  it('throws when every attempt fails validation, leaving the caller to decide', async () => {
    createMock
      .mockReset()
      .mockResolvedValue({ content: [{ type: 'text', text: 'still not json' }] })
    verifyPlaceMock.mockReset()

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
    verifyPlaceMock.mockReset().mockImplementation(found({ lat: 61.8, lng: 9.6 }))

    const finds = await runRescan()

    expect(createMock).toHaveBeenCalledTimes(2)
    expect(finds[0].name).toBe('Nearby')
  })

  it('throws the transient-failure error when every attempt fails at the API level', async () => {
    createMock.mockReset().mockRejectedValue(new Error('529 overloaded_error'))
    verifyPlaceMock.mockReset()

    await expect(runRescan()).rejects.toThrow('529 overloaded_error')
    expect(createMock).toHaveBeenCalledTimes(2)
  })
})

describe('generateRescanCandidates — one streamed turn', () => {
  const NEAR = { lat: 61.1, lng: 10.5 }

  beforeEach(() => {
    vi.stubEnv('CLAUDE_API_KEY', 'test-key')
    verifyPlaceMock.mockReset().mockImplementation(found({ lat: 61.2, lng: 10.6 }))
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('streams the answer rather than waiting on one whole request', async () => {
    // Asserting the call shape is the only way to pin this from a unit test:
    // the timeout it prevents lives in the SDK's transport, not in our code.
    createMock.mockReset().mockResolvedValueOnce(responseWithFinds(['Nearby']))

    const { generateRescanCandidates } = await import('./rescanCorridor.js')
    await generateRescanCandidates({ center: NEAR, radiusKm: 25 })

    expect(createMock).toHaveBeenCalledTimes(1)
  })

  // pause_turn is a server-side-tool phenomenon: the tool runs inside
  // Anthropic's own sampling loop, and hitting that loop's ceiling is what
  // ends a turn early. With no tools there is no loop and no pause, which is
  // why the resumption machinery this call used to carry went with the
  // search rather than being kept "just in case".
  it('makes exactly one call per attempt, with nothing to resume', async () => {
    createMock.mockReset().mockResolvedValue(responseWithFinds(['Nearby']))

    const { generateRescanCandidates } = await import('./rescanCorridor.js')
    await generateRescanCandidates({ center: NEAR, radiusKm: 25 })

    expect(createMock).toHaveBeenCalledTimes(1)
  })
})

describe('generateRescanCandidates — staying inside the caller\'s budget', () => {
  const NEAR = { lat: 61.1, lng: 10.5 }

  beforeEach(() => {
    vi.stubEnv('CLAUDE_API_KEY', 'test-key')
    verifyPlaceMock.mockReset().mockImplementation(found({ lat: 61.2, lng: 10.6 }))
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  // The reported failure: "Scanning… 5m 4s", then an error — the function's
  // own ceiling to the second. Counting attempts was the wrong bound; time
  // is the right one. Much less pressing now that a turn is one tool-free
  // call, but the deadline is still the caller's to state and still binds.
  it('does not start a retry it has no time to finish', async () => {
    createMock
      .mockReset()
      .mockResolvedValue({ content: [{ type: 'text', text: 'not json' }] })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { generateRescanCandidates } = await import('./rescanCorridor.js')
    await expect(
      generateRescanCandidates({
        center: NEAR,
        radiusKm: 25,
        // Already spent: room for the first turn and nothing after it.
        deadlineMs: Date.now() + 1_000,
      }),
    ).rejects.toBeDefined()

    // One turn — MAX_ATTEMPTS alone would have allowed a second.
    expect(createMock).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('no room for another turn'),
    )
    warn.mockRestore()
  })

  it('still retries when there is budget for it', async () => {
    createMock
      .mockReset()
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'not json' }] })
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

describe('generateRescanCandidates — a turn that produced nothing usable', () => {
  const NEAR = { lat: 61.1, lng: 10.5 }

  beforeEach(() => {
    vi.stubEnv('CLAUDE_API_KEY', 'test-key')
    verifyPlaceMock.mockReset().mockImplementation(found({ lat: 61.2, lng: 10.6 }))
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  // An assistant turn with empty content is rejected outright by the API, so
  // quoting an empty response back at Claude turned "the model returned no
  // text" into a 400 on the very attempt meant to recover from it — a
  // different and more confusing failure than the one that happened.
  it('never quotes an empty response back on the retry', async () => {
    createMock.mockReset().mockResolvedValue({ content: [] })

    const { generateRescanCandidates } = await import('./rescanCorridor.js')
    await expect(
      generateRescanCandidates({ center: NEAR, radiusKm: 25 }),
    ).rejects.toThrow(/no answer at all/i)

    for (const [params] of createMock.mock.calls as [
      { messages: { role: string; content: unknown }[] },
    ][]) {
      expect(params.messages.some((m) => m.content === '')).toBe(false)
    }
  })

  // "Unexpected end of JSON input" reads as Claude returning malformed JSON,
  // which is a prompt problem. Running out of output length is not. Those
  // have different fixes, and the wrong one was the only thing on screen.
  it('reports a truncated answer as truncated, not as malformed JSON', async () => {
    createMock.mockReset().mockResolvedValue({
      stop_reason: 'max_tokens',
      content: [{ type: 'text', text: '{"finds": [{"name": "Nea' }],
    })

    const { generateRescanCandidates } = await import('./rescanCorridor.js')
    await expect(
      generateRescanCandidates({ center: NEAR, radiusKm: 25 }),
    ).rejects.toThrow(/cut off/i)
  })
})

/**
 * "Nothing new found nearby" has to describe what actually happened.
 *
 * It was said when the search proposed real places that then failed their
 * map-data lookup — which is not the area being empty, is not the traveler's
 * to fix by zooming out, and points at Places rather than at the search. See
 * notLocated() and debug/curate.ts: proposed-then-rejected and never-proposed
 * are the two halves of the fork, and they have completely different fixes.
 */
describe('counting what was dropped, and why', () => {
  const NEAR = { lat: 61.1, lng: 10.5 }

  beforeEach(() => {
    vi.stubEnv('CLAUDE_API_KEY', 'test-key')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('counts finds that could not be located at all, apart from those too far', async () => {
    const { generateRescanCandidates, droppedForDistance, notLocated } =
      await import('./rescanCorridor.js')
    createMock
      .mockReset()
      .mockResolvedValueOnce(responseWithFinds(['Close', 'Far', 'Unlocatable']))
    verifyPlaceMock.mockReset().mockImplementation((query: string, expectedName: string) => {
      if (query.startsWith('Unlocatable')) return Promise.resolve(null)
      if (query.startsWith('Far'))
        return Promise.resolve({ name: expectedName, lat: 63, lng: 10.5 })
      return Promise.resolve({ name: expectedName, lat: 61.2, lng: 10.6 })
    })

    const finds = await generateRescanCandidates({ center: NEAR, radiusKm: 25 })

    expect(finds.map((find) => find.name)).toEqual(['Close'])
    expect(droppedForDistance(finds)).toBe(1)
    expect(notLocated(finds)).toBe(1)
  })

  it('reports nothing dropped when nothing was proposed', async () => {
    const { generateRescanCandidates, droppedForDistance, notLocated } =
      await import('./rescanCorridor.js')
    createMock.mockReset().mockResolvedValueOnce(responseWithFinds([]))
    verifyPlaceMock.mockReset()

    const finds = await generateRescanCandidates({ center: NEAR, radiusKm: 25 })

    expect(finds).toHaveLength(0)
    expect(droppedForDistance(finds)).toBe(0)
    expect(notLocated(finds)).toBe(0)
  })
})

describe('parseRescanResponse — an answer with a sentence around it', () => {
  const FINDS = {
    finds: [
      {
        name: 'Sunne Bike Park',
        country: 'SE',
        why: 'Lift-served downhill trails for a range of abilities.',
      },
    ],
  }

  it('reads an answer introduced by a sentence', () => {
    const parsed = parseRescanResponse(
      `Based on my searches, here are the standout stops near Sunne:\n\n${JSON.stringify(FINDS)}`,
    )
    expect(parsed.finds[0].name).toBe('Sunne Bike Park')
  })

  it('reads an answer that keeps talking afterwards', () => {
    const parsed = parseRescanResponse(
      `${JSON.stringify(FINDS)}\n\nLet me know if you would like me to widen the search!`,
    )
    expect(parsed.finds[0].name).toBe('Sunne Bike Park')
  })

  it('reads an answer wrapped in both, inside a code fence', () => {
    const parsed = parseRescanResponse(
      `Here is what I found:\n\n\`\`\`json\n${JSON.stringify(FINDS)}\n\`\`\`\n\nHope that helps.`,
    )
    expect(parsed.finds[0].name).toBe('Sunne Bike Park')
  })

  it('reads an empty answer wrapped in prose — "nothing nearby" still counts', () => {
    expect(
      parseRescanResponse(
        'I searched thoroughly and found nothing worth a detour.\n\n{"finds": []}',
      ).finds,
    ).toHaveLength(0)
  })

  // Tolerance is not credulity: a response with no JSON in it is still a
  // failure, and it now says what arrived instead of naming a character.
  it('still fails on a response with no JSON in it, and says what came back', () => {
    expect(() =>
      parseRescanResponse('I was unable to search the web just now.'),
    ).toThrow(/no JSON at all.*unable to search/i)
  })
})

/**
 * Reported with two screenshots: a card reading "Vrå Bike Park" whose pin sat
 * precisely on Vallåsen Bike Park, and a "Photos & details" tap that opened
 * directions to the village of Vrå, an hour away.
 *
 * The pin was right the whole time. Places had resolved the query correctly
 * and handed back the real listing — its own name and its own URL — and the
 * old geocodeQuery call kept nothing but the coordinate. So the card carried
 * Claude's version of the name, and with no listing URL stored the details
 * link fell back to searching Google for that name, which resolves to a
 * village because no such bike park exists under it.
 */
describe('generateRescanCandidates — taking the name from the map, not the model', () => {
  const NEAR = { lat: 56.4, lng: 13.1 }

  beforeEach(() => {
    vi.stubEnv('CLAUDE_API_KEY', 'test-key')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("replaces the model's name with the one Places actually matched", async () => {
    createMock
      .mockReset()
      .mockResolvedValueOnce(responseWithFinds(['Vrå Bike Park']))
    verifyPlaceMock.mockReset().mockResolvedValue({
      name: 'Vallåsen Bike Park',
      lat: 56.41,
      lng: 13.11,
      googleMapsUrl: 'https://maps.google.com/?cid=123',
    })

    const { generateRescanCandidates } = await import('./rescanCorridor.js')
    const finds = await generateRescanCandidates({ center: NEAR, radiusKm: 25 })

    expect(finds[0].name).toBe('Vallåsen Bike Park')
    expect(finds[0].googleMapsUrl).toBe('https://maps.google.com/?cid=123')
  })

  // Without this the details link falls back to a name search, which is what
  // sent a traveler to a village an hour away.
  it('keeps the listing URL so the details link never has to guess', async () => {
    createMock.mockReset().mockResolvedValueOnce(responseWithFinds(['Somewhere']))
    verifyPlaceMock
      .mockReset()
      .mockResolvedValue({ name: 'Somewhere', lat: 56.41, lng: 13.11 })

    const { generateRescanCandidates } = await import('./rescanCorridor.js')
    const finds = await generateRescanCandidates({ center: NEAR, radiusKm: 25 })

    // Absent rather than invented when Places has no URL for the listing —
    // placeDetailsUrl's own fallback is correct in that case.
    expect(finds[0]).not.toHaveProperty('googleMapsUrl')
  })

  // Geography is filterFindsToCorridor's job and has to stay only its job:
  // verification bounded to Places' default 30km would silently lose every
  // find further than that from the map centre on a route-wide search.
  it('checks identity without imposing a distance bound of its own', async () => {
    createMock.mockReset().mockResolvedValueOnce(responseWithFinds(['Far along the route']))
    verifyPlaceMock
      .mockReset()
      .mockResolvedValue({ name: 'Far along the route', lat: 61.5, lng: 9.0 })

    const { generateRescanCandidates } = await import('./rescanCorridor.js')
    await generateRescanCandidates({
      center: NEAR,
      radiusKm: 25,
      backbone: [
        { lat: 61.0, lng: 9.0 },
        { lat: 62.0, lng: 9.0 },
      ],
    })

    expect(verifyPlaceMock).toHaveBeenCalledWith(
      expect.any(String),
      'Far along the route',
      NEAR,
      Number.POSITIVE_INFINITY,
    )
  })
})
