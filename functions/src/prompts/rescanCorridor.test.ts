import { describe, expect, it, vi } from 'vitest'
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

const createMock = vi.fn()
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: createMock }
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
