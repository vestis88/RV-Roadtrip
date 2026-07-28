import { describe, expect, it, vi } from 'vitest'
import type { TripSettings } from '@rv/shared'
import {
  MAX_ENRICHMENT_DETOUR_KM,
  buildHighlightsBackbone,
  parseEnrichedHighlights,
} from './enrichHighlights.js'

const RECORDED_RESPONSE = `\`\`\`json
{
  "regions": [
    {
      "region": "Inland lakes",
      "country": "NO",
      "reasoning": "Newly reopened family attractions the first pass wouldn't know about.",
      "candidateStops": [
        {
          "town": "Nearby",
          "country": "NO",
          "why": "A science centre that reopened this spring after a two-year rebuild, with a hands-on water-play hall aimed squarely at primary-school ages. The town itself is a quiet lakeside stop with a swimming beach. Fits the stated interest in hands-on museums and an eight-year-old who needs somewhere to burn energy.",
          "priority": "worth-a-detour"
        }
      ]
    }
  ]
}
\`\`\``

describe('parseEnrichedHighlights', () => {
  it('parses a recorded response', () => {
    const parsed = parseEnrichedHighlights(RECORDED_RESPONSE)
    expect(parsed.regions).toHaveLength(1)
    expect(parsed.regions[0].candidateStops[0].town).toBe('Nearby')
  })

  it('accepts an empty regions list — "we found nothing worthwhile" is a real answer', () => {
    expect(parseEnrichedHighlights('{"regions": []}').regions).toHaveLength(0)
  })

  it('throws on a response missing required fields', () => {
    expect(() =>
      parseEnrichedHighlights('{"regions": [{"region": "x"}]}'),
    ).toThrow()
  })

  it('rejects a region with no candidate stops rather than letting an empty one through', () => {
    expect(() =>
      parseEnrichedHighlights(
        '{"regions": [{"region": "x", "country": "NO", "reasoning": "y", "candidateStops": []}]}',
      ),
    ).toThrow()
  })
})

// A synthetic meridian corridor with hand-checkable geometry, the same setup
// the highlights-review e2e tests use: start (50,10) → must-see (52,10) →
// finish (54,10). One degree of longitude at this latitude is ~70 km, which
// works out to a ~40 km cheapest-insertion detour — comfortably inside the
// limit; three degrees is ~250 km, comfortably outside it.
const SETTINGS = {
  startPoint: { name: 'South end', lat: 50, lng: 10 },
  endPoint: { name: 'North end', lat: 54, lng: 10 },
  interests: ['hiking'],
  preferredCountries: ['NO'],
  travelers: [],
} as unknown as TripSettings

const CURATED = {
  regions: [
    {
      region: 'Meridian country',
      country: 'NO',
      reasoning: 'The corridor the trip is already built around.',
      candidateStops: [
        {
          town: 'Midpoint',
          country: 'NO',
          why: 'The anchor of the trip.',
          priority: 'must-see' as const,
          lat: 52,
          lng: 10,
        },
      ],
    },
  ],
}

const BACKBONE = [
  { lat: 50, lng: 10 },
  { lat: 52, lng: 10 },
  { lat: 54, lng: 10 },
]

describe('buildHighlightsBackbone', () => {
  it('runs start → located must-sees → finish, skipping everything else', () => {
    expect(buildHighlightsBackbone(SETTINGS, CURATED)).toEqual([
      SETTINGS.startPoint,
      { lat: 52, lng: 10 },
      SETTINGS.endPoint,
    ])
  })

  it('skips must-sees that never geocoded', () => {
    const ungeocoded = {
      regions: [
        {
          ...CURATED.regions[0],
          candidateStops: [
            { ...CURATED.regions[0].candidateStops[0], lat: undefined, lng: undefined },
          ],
        },
      ],
    }
    expect(buildHighlightsBackbone(SETTINGS, ungeocoded)).toEqual([
      SETTINGS.startPoint,
      SETTINGS.endPoint,
    ])
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

function responseWithStops(
  stops: { town: string; priority?: string }[],
): { content: { type: string; text: string }[] } {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          regions: [
            {
              region: 'Web finds',
              country: 'NO',
              reasoning: 'Things the knowledge-only pass could not have known.',
              candidateStops: stops.map((stop) => ({
                town: stop.town,
                country: 'NO',
                why: `Why ${stop.town}.`,
                priority: stop.priority ?? 'worth-a-detour',
              })),
            },
          ],
        }),
      },
    ],
  }
}

async function runEnrichment() {
  const { generateEnrichedHighlights } = await import('./enrichHighlights.js')
  return generateEnrichedHighlights({
    settings: SETTINGS,
    notesFreeText: 'We like hands-on museums.',
    highlights: CURATED,
    backbone: BACKBONE,
  })
}

describe('generateEnrichedHighlights', () => {
  it('offers web search, tags finds as search-sourced, and geocodes them', async () => {
    createMock.mockReset().mockResolvedValueOnce(responseWithStops([{ town: 'Nearby' }]))
    geocodeQueryMock.mockReset().mockResolvedValue({ lat: 51, lng: 11 })

    const regions = await runEnrichment()

    expect(regions).toHaveLength(1)
    expect(regions[0].candidateStops).toHaveLength(1)
    expect(regions[0].candidateStops[0]).toMatchObject({
      town: 'Nearby',
      source: 'search',
      lat: 51,
      lng: 11,
    })

    // Geocoded the same way the base highlights pass does it: town + country,
    // biased near the trip's start point.
    expect(geocodeQueryMock).toHaveBeenCalledWith('Nearby, NO', SETTINGS.startPoint)

    const [params] = createMock.mock.calls[0] as [
      { tools?: { type: string }[]; thinking?: { type: string }; system: string },
    ]
    expect(params.tools?.some((t) => t.type === 'web_search_20260209')).toBe(true)
    expect(params.thinking).toEqual({ type: 'disabled' })
    // The no-synthetic-geography rule has to actually reach the model.
    expect(params.system).toMatch(/DO NOT invent/i)
  })

  it(`drops a find more than ${MAX_ENRICHMENT_DETOUR_KM} km off the route`, async () => {
    createMock
      .mockReset()
      .mockResolvedValueOnce(
        responseWithStops([{ town: 'Nearby' }, { town: 'Far Away' }]),
      )
    geocodeQueryMock
      .mockReset()
      .mockImplementation((query: string) =>
        Promise.resolve(
          query.startsWith('Far Away')
            ? { lat: 51, lng: 13 } // ~250 km of extra driving
            : { lat: 51, lng: 11 }, // ~40 km of extra driving
        ),
      )

    const regions = await runEnrichment()

    expect(regions[0].candidateStops.map((stop) => stop.town)).toEqual(['Nearby'])
  })

  it('drops a find that never geocoded rather than letting it through unchecked', async () => {
    createMock
      .mockReset()
      .mockResolvedValueOnce(
        responseWithStops([{ town: 'Nearby' }, { town: 'Unlocatable' }]),
      )
    geocodeQueryMock
      .mockReset()
      .mockImplementation((query: string) =>
        Promise.resolve(
          query.startsWith('Unlocatable') ? null : { lat: 51, lng: 11 },
        ),
      )

    const regions = await runEnrichment()

    expect(regions[0].candidateStops.map((stop) => stop.town)).toEqual(['Nearby'])
  })

  it('drops a region whole when nothing in it survives, rather than returning an empty one', async () => {
    createMock.mockReset().mockResolvedValueOnce(responseWithStops([{ town: 'Far Away' }]))
    geocodeQueryMock.mockReset().mockResolvedValue({ lat: 51, lng: 13 })

    // An empty candidateStops array would fail regionHighlightSchema when the
    // traveler's edited highlights come back for the outline phase.
    expect(await runEnrichment()).toEqual([])
  })

  it('returns nothing when the search itself found nothing', async () => {
    createMock.mockReset().mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"regions": []}' }],
    })
    geocodeQueryMock.mockReset()

    expect(await runEnrichment()).toEqual([])
    expect(geocodeQueryMock).not.toHaveBeenCalled()
  })

  it('retries once on a schema failure and succeeds on the second attempt', async () => {
    createMock
      .mockReset()
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'not valid json' }] })
      .mockResolvedValueOnce(responseWithStops([{ town: 'Nearby' }]))
    geocodeQueryMock.mockReset().mockResolvedValue({ lat: 51, lng: 11 })

    const regions = await runEnrichment()

    expect(createMock).toHaveBeenCalledTimes(2)
    expect(regions[0].candidateStops[0].town).toBe('Nearby')
  })

  it('throws when every attempt fails validation, leaving the caller to decide', async () => {
    createMock
      .mockReset()
      .mockResolvedValue({ content: [{ type: 'text', text: 'still not json' }] })
    geocodeQueryMock.mockReset()

    await expect(runEnrichment()).rejects.toBeDefined()
    expect(createMock).toHaveBeenCalledTimes(2)
  })
})
