import { describe, expect, it, vi } from 'vitest'
import {
  parseAndValidateRouteOutline,
  parseChunkDetail,
  parseRegionHighlights,
  parseRouteOutline,
} from './planTrip.js'
import type { RegionHighlightsResponse } from './planTripSchema.js'

const RECORDED_HIGHLIGHTS = `\`\`\`json
{
  "regions": [
    {
      "region": "Norwegian fjord country",
      "country": "NO",
      "reasoning": "Dramatic scenery and family-friendly Olympic-era attractions, great for active families with kids.",
      "candidateStops": [
        { "town": "Lillehammer", "country": "NO", "why": "Olympic sights and the Hunderfossen family theme park.", "priority": "must-see" },
        { "town": "Geiranger", "country": "NO", "why": "World-famous fjord viewpoints.", "priority": "worth-a-detour" }
      ]
    }
  ]
}
\`\`\``

const RECORDED_OUTLINE = `\`\`\`json
{
  "days": [
    {
      "index": 0,
      "date": "2026-07-10",
      "type": "drive",
      "overnight": { "name": "Lillehammer Camping", "town": "Lillehammer", "country": "NO", "campsiteSuggestion": "Lillehammer Camping" },
      "drive": { "fromTown": "Oslo", "toTown": "Lillehammer", "slot": "morning" },
      "highlightReason": "Gateway to the Olympic sights and Hunderfossen family park, matching the kids' interest in theme parks."
    },
    {
      "index": 1,
      "date": "2026-07-11",
      "type": "rest",
      "overnight": { "name": "Lillehammer Camping", "town": "Lillehammer", "country": "NO" },
      "highlightReason": "Extra day to explore Maihaugen and the lakeside without driving."
    }
  ]
}
\`\`\``

function activities() {
  return [
    {
      name: 'Maihaugen Open-Air Museum',
      town: 'Lillehammer',
      category: 'museum',
      kidFriendly: true,
      blurb: 'A hidden-gem open-air museum the kids will love.',
    },
    {
      name: 'Lysgårdsbakkene Ski Jumping Arena',
      town: 'Lillehammer',
      category: 'sight',
      kidFriendly: true,
      blurb: 'Olympic ski jump with a viewing platform.',
    },
    {
      name: 'Hunderfossen Family Park',
      town: 'Øyer',
      category: 'playground',
      kidFriendly: true,
      blurb: 'A classic family theme park just outside town.',
    },
    {
      name: 'Mjøsa lakeside walk',
      town: 'Lillehammer',
      category: 'hike',
      kidFriendly: true,
      blurb: 'A gentle lakeside stroll with picnic spots.',
    },
    {
      name: 'Lillehammer Art Museum',
      town: 'Lillehammer',
      category: 'sight',
      kidFriendly: false,
      blurb: 'A striking modern building with Norwegian art.',
    },
  ]
}

function restaurants() {
  return [
    {
      name: 'Nikkers',
      town: 'Lillehammer',
      meal: 'breakfast',
      cuisine: 'Norwegian',
      blurb: 'Cozy breakfast spot near the river.',
    },
    {
      name: 'Bakeriet i Lillehammer',
      town: 'Lillehammer',
      meal: 'breakfast',
      cuisine: 'Bakery',
      blurb: 'Local bakery with fresh pastries.',
    },
    {
      name: 'Cafe Klosteret',
      town: 'Lillehammer',
      meal: 'breakfast',
      cuisine: 'Cafe',
      blurb: 'Relaxed café in a historic building.',
    },
    {
      name: 'Vertshuset',
      town: 'Lillehammer',
      meal: 'lunch',
      cuisine: 'Norwegian',
      blurb: 'Traditional lunch fare in the old town.',
    },
    {
      name: 'Svare & Berg',
      town: 'Lillehammer',
      meal: 'lunch',
      cuisine: 'Contemporary',
      blurb: 'Modern bistro with a seasonal menu.',
    },
    {
      name: 'Nikkers Lunsj',
      town: 'Lillehammer',
      meal: 'lunch',
      cuisine: 'Norwegian',
      blurb: 'Same cozy spot, hearty midday plates.',
    },
    {
      name: 'Bryggerikjelleren',
      town: 'Lillehammer',
      meal: 'dinner',
      cuisine: 'Norwegian',
      blurb: 'Cozy cellar restaurant near the river.',
    },
    {
      name: 'Egon Lillehammer',
      town: 'Lillehammer',
      meal: 'dinner',
      cuisine: 'Family',
      blurb: 'Reliable family-friendly chain restaurant.',
    },
    {
      name: 'Sushi Bar Lillehammer',
      town: 'Lillehammer',
      meal: 'dinner',
      cuisine: 'Japanese',
      blurb: 'A change of pace with fresh sushi.',
    },
  ]
}

function dayDetailResponseFor(indices: number[]): string {
  return JSON.stringify({
    days: indices.map((index) => ({
      index,
      summary: `Day ${index} summary.`,
      activities: activities(),
      restaurants: restaurants(),
    })),
  })
}

const RECORDED_CHUNK_DETAIL = dayDetailResponseFor([0, 1])

describe('parseRegionHighlights', () => {
  it('parses a recorded highlights response', () => {
    const highlights = parseRegionHighlights(RECORDED_HIGHLIGHTS)
    expect(highlights.regions).toHaveLength(1)
    expect(highlights.regions[0].candidateStops[0].town).toBe('Lillehammer')
    expect(highlights.regions[0].candidateStops[0].priority).toBe('must-see')
  })

  // A trivial/short/local trip can genuinely have nothing worth flagging —
  // an empty regions array (or a region with an empty candidateStops array)
  // is a valid, honest response, not a schema violation. Previously
  // required min(1) at both levels, which meant the only way for Claude to
  // satisfy the schema on such a trip was to retry into the same empty
  // response and eventually fail outright — reported as "find great stops"
  // simply not working for a one-day trip.
  it('accepts an empty regions array, and a region with an empty candidateStops array', () => {
    expect(parseRegionHighlights('{"regions": []}').regions).toEqual([])
    const withEmptyRegion = parseRegionHighlights(
      '{"regions": [{"region": "x", "country": "NO", "reasoning": "y", "candidateStops": []}]}',
    )
    expect(withEmptyRegion.regions[0].candidateStops).toEqual([])
  })

  it('throws on a response that violates the schema', () => {
    expect(() =>
      parseRegionHighlights('{"regions": [{"region": "x"}]}'),
    ).toThrow()
  })
})

describe('parseRouteOutline', () => {
  it('parses a recorded outline response', () => {
    const outline = parseRouteOutline(RECORDED_OUTLINE)
    expect(outline.days).toHaveLength(2)
    expect(outline.days[0].overnight.name).toBe('Lillehammer Camping')
    expect(outline.days[0].drive?.toTown).toBe('Lillehammer')
  })

  it('throws on a response that violates the schema', () => {
    expect(() => parseRouteOutline('{"days": []}')).toThrow()
    expect(() => parseRouteOutline('{"days": [{"index": 0}]}')).toThrow()
  })
})

describe('parseAndValidateRouteOutline', () => {
  it('accepts a recorded outline with contiguous 0-based indices', () => {
    const outline = parseAndValidateRouteOutline(RECORDED_OUTLINE)
    expect(outline.days.map((d) => d.index)).toEqual([0, 1])
  })

  it('rejects 1-based day numbering', () => {
    const oneBased = RECORDED_OUTLINE.replace(
      '"index": 0',
      '"index": 1',
    ).replace(
      '"index": 1,\n      "date": "2026-07-11"',
      '"index": 2,\n      "date": "2026-07-11"',
    )
    expect(() => parseAndValidateRouteOutline(oneBased)).toThrow(/0-based/)
  })

  it('rejects a gap in indices', () => {
    const gapped = RECORDED_OUTLINE.replace(
      '"index": 1,\n      "date": "2026-07-11"',
      '"index": 2,\n      "date": "2026-07-11"',
    )
    expect(() => parseAndValidateRouteOutline(gapped)).toThrow(/0-based/)
  })
})

describe('parseChunkDetail', () => {
  it('parses a recorded chunk-detail response', () => {
    const detail = parseChunkDetail(RECORDED_CHUNK_DETAIL)
    expect(detail.days).toHaveLength(2)
    expect(detail.days[0].activities).toHaveLength(5)
    expect(detail.days[0].restaurants).toHaveLength(9)
  })

  it('throws on a response missing required fields', () => {
    expect(() => parseChunkDetail('{"days": [{"index": 0}]}')).toThrow()
  })
})

const createMock = vi.fn()

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: createMock }
  },
}))

// vi.hoisted, unlike the plain const above: vi.mock is hoisted above every
// top-level statement, and this factory dereferences the mock as it runs
// (rather than lazily inside a class body, the way the Anthropic one does),
// so the binding has to be hoisted with it.
const geocodeQueryMock = vi.hoisted(() => vi.fn())

// placesApi also exports the googlePlacesApiKey secret constant, which
// planTrip.ts's own module graph pulls in — spreading the real module keeps
// that (and every other export) intact while swapping only geocodeQuery.
vi.mock('../placesApi.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../placesApi.js')>()
  return { ...actual, geocodeQuery: geocodeQueryMock }
})

const SETTINGS_WITH_START = {
  startPoint: { name: 'Oslo, Norway', lat: 59.9139, lng: 10.7522 },
} as never

function textResponse(text: string) {
  return { content: [{ type: 'text', text }], stop_reason: 'end_turn' }
}

describe('planTrip', () => {
  it('assembles the highlights, outline, and a single chunk into one skeleton', async () => {
    createMock.mockReset()
    createMock
      .mockResolvedValueOnce(textResponse(RECORDED_HIGHLIGHTS))
      .mockResolvedValueOnce(textResponse(RECORDED_OUTLINE))
      .mockResolvedValueOnce(textResponse(RECORDED_CHUNK_DETAIL))

    const { planTrip } = await import('./planTrip.js')
    const onProgress = vi.fn()
    const result = await planTrip({
      settings: {} as never,
      notesFreeText: 'no allergies',
      onProgress,
    })

    expect(createMock).toHaveBeenCalledTimes(3)
    expect(result.days).toHaveLength(2)
    // Route fields come from the outline, detail fields from the chunk call.
    expect(result.days[0].overnight.name).toBe('Lillehammer Camping')
    expect(result.days[0].drive?.toTown).toBe('Lillehammer')
    expect(result.days[0].activities).toHaveLength(5)
    expect(result.days[1].type).toBe('rest')
    expect(onProgress).toHaveBeenCalledWith({ phase: 'highlights' })
    expect(onProgress).toHaveBeenCalledWith({ phase: 'outline' })

    // A single-chunk trip has no second call to read a cache back — caching
    // it would only pay the write premium for zero reads, so no breakpoint.
    const chunkCallArgs = createMock.mock.calls[2][0]
    expect(chunkCallArgs.messages[0].content[0].cache_control).toBeUndefined()
  })

  it('splits a longer route into multiple chunk calls and reassembles them in order', async () => {
    createMock.mockReset()
    const tenDayOutline = {
      days: Array.from({ length: 10 }, (_, index) => ({
        index,
        date: `2026-07-${10 + index}`,
        type: 'drive',
        overnight: {
          name: `Stop ${index}`,
          town: `Town ${index}`,
          country: 'NO',
        },
        drive: {
          fromTown: `Town ${index - 1}`,
          toTown: `Town ${index}`,
          slot: 'morning',
        },
        highlightReason: `Reason for stop ${index}.`,
      })),
    }
    createMock
      .mockResolvedValueOnce(textResponse(RECORDED_HIGHLIGHTS))
      .mockResolvedValueOnce(textResponse(JSON.stringify(tenDayOutline)))
      // CHUNK_SIZE is 7, so 10 days split into a 7-day and a 3-day call.
      .mockResolvedValueOnce(
        textResponse(dayDetailResponseFor([0, 1, 2, 3, 4, 5, 6])),
      )
      .mockResolvedValueOnce(textResponse(dayDetailResponseFor([7, 8, 9])))

    const { planTrip } = await import('./planTrip.js')
    const onProgress = vi.fn()
    const result = await planTrip({
      settings: {} as never,
      notesFreeText: '',
      onProgress,
    })

    expect(createMock).toHaveBeenCalledTimes(4)
    expect(result.days).toHaveLength(10)
    expect(result.days.map((d) => d.index)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ])
    expect(result.days[9].overnight.name).toBe('Stop 9')
    expect(onProgress).toHaveBeenCalledWith({ phase: 'highlights' })
    expect(onProgress).toHaveBeenCalledWith({ phase: 'outline' })
    expect(onProgress).toHaveBeenCalledWith({
      phase: 'detail',
      chunkIndex: 1,
      chunkCount: 2,
    })
    expect(onProgress).toHaveBeenCalledWith({
      phase: 'detail',
      chunkIndex: 2,
      chunkCount: 2,
    })

    // Both chunk calls share the same settings/notes/fullRouteOutline
    // prefix — it's cached on the first call and read back on the second.
    const firstChunkArgs = createMock.mock.calls[2][0]
    const secondChunkArgs = createMock.mock.calls[3][0]
    const firstStableBlock = firstChunkArgs.messages[0].content[0]
    const secondStableBlock = secondChunkArgs.messages[0].content[0]
    expect(firstStableBlock.cache_control).toEqual({ type: 'ephemeral' })
    expect(secondStableBlock.cache_control).toEqual({ type: 'ephemeral' })
    expect(firstStableBlock.text).toBe(secondStableBlock.text)
    // The varying suffix (daysNeedingDetail) differs between chunks.
    expect(firstChunkArgs.messages[0].content[1].text).not.toBe(
      secondChunkArgs.messages[0].content[1].text,
    )
  })

  it('retries the outline call once on a schema failure and succeeds on the second attempt', async () => {
    createMock.mockReset()
    createMock
      .mockResolvedValueOnce(textResponse(RECORDED_HIGHLIGHTS))
      .mockResolvedValueOnce(textResponse('not valid json'))
      .mockResolvedValueOnce(textResponse(RECORDED_OUTLINE))
      .mockResolvedValueOnce(textResponse(RECORDED_CHUNK_DETAIL))

    const { planTrip } = await import('./planTrip.js')
    const result = await planTrip({ settings: {} as never, notesFreeText: '' })

    expect(createMock).toHaveBeenCalledTimes(4)
    expect(result.days).toHaveLength(2)
  })

  // Regression: callWithRetry's loop previously only caught a malformed-JSON
  // response — a transient API-level failure (rate limit, brief overload,
  // network blip) from client.messages.create itself propagated immediately
  // with no retry at all, defeating the whole point of MAX_ATTEMPTS.
  it('retries a call once on a transient API-level failure and succeeds on the second attempt', async () => {
    createMock.mockReset()
    createMock
      .mockRejectedValueOnce(new Error('529 overloaded_error'))
      .mockResolvedValueOnce(textResponse(RECORDED_HIGHLIGHTS))
      .mockResolvedValueOnce(textResponse(RECORDED_OUTLINE))
      .mockResolvedValueOnce(textResponse(RECORDED_CHUNK_DETAIL))

    const { planTrip } = await import('./planTrip.js')
    const result = await planTrip({ settings: {} as never, notesFreeText: '' })

    expect(createMock).toHaveBeenCalledTimes(4)
    expect(result.days).toHaveLength(2)
  })

  it('retries the outline call when Claude numbers days 1-based instead of 0-based', async () => {
    createMock.mockReset()
    const oneBasedOutline = JSON.stringify({
      days: JSON.parse(RECORDED_OUTLINE.replace(/```json|```/g, '')).days.map(
        (day: { index: number }) => ({ ...day, index: day.index + 1 }),
      ),
    })
    createMock
      .mockResolvedValueOnce(textResponse(RECORDED_HIGHLIGHTS))
      .mockResolvedValueOnce(textResponse(oneBasedOutline))
      .mockResolvedValueOnce(textResponse(RECORDED_OUTLINE))
      .mockResolvedValueOnce(textResponse(RECORDED_CHUNK_DETAIL))

    const { planTrip } = await import('./planTrip.js')
    const result = await planTrip({ settings: {} as never, notesFreeText: '' })

    expect(createMock).toHaveBeenCalledTimes(4)
    expect(result.days.map((d) => d.index)).toEqual([0, 1])
  })

  it('throws after the outline retry also fails schema validation', async () => {
    createMock.mockReset()
    createMock
      .mockResolvedValueOnce(textResponse(RECORDED_HIGHLIGHTS))
      .mockResolvedValue(textResponse('still not valid json'))

    const { planTrip } = await import('./planTrip.js')
    await expect(
      planTrip({ settings: {} as never, notesFreeText: '' }),
    ).rejects.toThrow()

    expect(createMock).toHaveBeenCalledTimes(3)
  })

  it('throws after the highlights retry also fails schema validation', async () => {
    createMock.mockReset()
    createMock.mockResolvedValue(textResponse('still not valid json'))

    const { planTrip } = await import('./planTrip.js')
    await expect(
      planTrip({ settings: {} as never, notesFreeText: '' }),
    ).rejects.toThrow()

    expect(createMock).toHaveBeenCalledTimes(2)
  })

  it('throws if Claude never returns detail for one of the outline days', async () => {
    createMock.mockReset()
    createMock
      .mockResolvedValueOnce(textResponse(RECORDED_HIGHLIGHTS))
      .mockResolvedValueOnce(textResponse(RECORDED_OUTLINE))
      // Only returns day 0's detail, missing day 1.
      .mockResolvedValueOnce(textResponse(dayDetailResponseFor([0])))

    const { planTrip } = await import('./planTrip.js')
    await expect(
      planTrip({ settings: {} as never, notesFreeText: '' }),
    ).rejects.toThrow(/day index 1/)
  })
})

describe('generateRegionHighlights + generateSkeletonFromHighlights (review-pause split)', () => {
  it('generateRegionHighlights makes exactly one call and returns the parsed highlights', async () => {
    createMock.mockReset()
    createMock.mockResolvedValueOnce(textResponse(RECORDED_HIGHLIGHTS))

    const { generateRegionHighlights } = await import('./planTrip.js')
    const highlights = await generateRegionHighlights({
      settings: {} as never,
      notesFreeText: '',
    })

    expect(createMock).toHaveBeenCalledTimes(1)
    expect(highlights.regions[0].candidateStops[0].town).toBe('Lillehammer')
  })

  it('generateSkeletonFromHighlights, given highlights already resolved, never asks for highlights again', async () => {
    createMock.mockReset()
    createMock
      .mockResolvedValueOnce(textResponse(RECORDED_OUTLINE))
      .mockResolvedValueOnce(textResponse(RECORDED_CHUNK_DETAIL))

    const { generateSkeletonFromHighlights } = await import('./planTrip.js')
    const highlights = { regions: [] } as unknown as RegionHighlightsResponse
    const onProgress = vi.fn()
    const skeleton = await generateSkeletonFromHighlights({
      settings: {} as never,
      notesFreeText: '',
      highlights,
      onProgress,
    })

    expect(createMock).toHaveBeenCalledTimes(2) // outline + 1 detail chunk only
    expect(skeleton.days).toHaveLength(2)
    expect(onProgress).toHaveBeenCalledWith({ phase: 'outline' })
    expect(onProgress).not.toHaveBeenCalledWith({ phase: 'highlights' })
  })

  it('attaches geocoded lat/lng to every candidate stop', async () => {
    createMock.mockReset()
    createMock.mockResolvedValueOnce(textResponse(RECORDED_HIGHLIGHTS))
    geocodeQueryMock.mockReset()
    geocodeQueryMock
      .mockResolvedValueOnce({ lat: 61.1153, lng: 10.4662 })
      .mockResolvedValueOnce({ lat: 62.1008, lng: 7.2064 })

    const { generateRegionHighlights } = await import('./planTrip.js')
    const highlights = await generateRegionHighlights({
      settings: SETTINGS_WITH_START,
      notesFreeText: '',
    })

    const [lillehammer, geiranger] = highlights.regions[0].candidateStops
    expect(lillehammer).toMatchObject({
      town: 'Lillehammer',
      lat: 61.1153,
      lng: 10.4662,
    })
    expect(geiranger).toMatchObject({
      town: 'Geiranger',
      lat: 62.1008,
      lng: 7.2064,
    })
    // Queried by "town, country", biased near the trip's start point.
    expect(geocodeQueryMock).toHaveBeenCalledWith('Lillehammer, NO', {
      name: 'Oslo, Norway',
      lat: 59.9139,
      lng: 10.7522,
    })
  })

  it('degrades to a candidate with no coordinates when geocoding throws (e.g. no Places key)', async () => {
    createMock.mockReset()
    createMock.mockResolvedValueOnce(textResponse(RECORDED_HIGHLIGHTS))
    geocodeQueryMock.mockReset()
    geocodeQueryMock.mockRejectedValue(
      new Error('GOOGLE_PLACES_API_KEY is not configured'),
    )

    const { generateRegionHighlights } = await import('./planTrip.js')
    const highlights = await generateRegionHighlights({
      settings: SETTINGS_WITH_START,
      notesFreeText: '',
    })

    const [lillehammer] = highlights.regions[0].candidateStops
    // Everything else survives — only the coordinates are missing.
    expect(lillehammer.town).toBe('Lillehammer')
    expect(lillehammer.priority).toBe('must-see')
    expect(lillehammer.why).toContain('Olympic')
    expect(lillehammer.lat).toBeUndefined()
    expect(lillehammer.lng).toBeUndefined()
  })

  it('degrades to a candidate with no coordinates when the town does not resolve', async () => {
    createMock.mockReset()
    createMock.mockResolvedValueOnce(textResponse(RECORDED_HIGHLIGHTS))
    geocodeQueryMock.mockReset()
    // First town resolves, second returns no match at all.
    geocodeQueryMock
      .mockResolvedValueOnce({ lat: 61.1153, lng: 10.4662 })
      .mockResolvedValueOnce(null)

    const { generateRegionHighlights } = await import('./planTrip.js')
    const highlights = await generateRegionHighlights({
      settings: SETTINGS_WITH_START,
      notesFreeText: '',
    })

    const [lillehammer, geiranger] = highlights.regions[0].candidateStops
    expect(lillehammer.lat).toBe(61.1153)
    expect(geiranger.town).toBe('Geiranger')
    expect(geiranger.lat).toBeUndefined()
  })

  it('skips geocoding entirely when the trip has no start point to bias from', async () => {
    createMock.mockReset()
    createMock.mockResolvedValueOnce(textResponse(RECORDED_HIGHLIGHTS))
    geocodeQueryMock.mockReset()

    const { generateRegionHighlights } = await import('./planTrip.js')
    const highlights = await generateRegionHighlights({
      settings: {} as never,
      notesFreeText: '',
    })

    expect(geocodeQueryMock).not.toHaveBeenCalled()
    expect(highlights.regions[0].candidateStops[0].lat).toBeUndefined()
  })

  it('planTrip (the combined path) is unaffected by the split — still highlights + outline + detail', async () => {
    createMock.mockReset()
    createMock
      .mockResolvedValueOnce(textResponse(RECORDED_HIGHLIGHTS))
      .mockResolvedValueOnce(textResponse(RECORDED_OUTLINE))
      .mockResolvedValueOnce(textResponse(RECORDED_CHUNK_DETAIL))

    const { planTrip } = await import('./planTrip.js')
    const result = await planTrip({ settings: {} as never, notesFreeText: '' })

    expect(createMock).toHaveBeenCalledTimes(3)
    expect(result.days).toHaveLength(2)
  })
})
