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
        { "sight": "Hunderfossen Familiepark", "town": "Lillehammer", "country": "NO", "interest": "theme parks", "timeNeeded": "full-day", "why": "Olympic sights and the Hunderfossen family theme park.", "priority": "must-see" },
        { "sight": "Geiranger Skywalk", "town": "Geiranger", "country": "NO", "interest": "viewpoints", "timeNeeded": "couple-of-hours", "why": "World-famous fjord viewpoints.", "priority": "worth-a-detour" }
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
      "sights": ["Hunderfossen Familiepark"],
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
const verifyPlaceLocationMock = vi.hoisted(() => vi.fn())

// placesApi also exports the googlePlacesApiKey secret constant, which
// planTrip.ts's own module graph pulls in — spreading the real module keeps
// that (and every other export) intact while swapping only the two lookups
// the curation phase makes: the base town, then the sight against it.
vi.mock('../placesApi.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../placesApi.js')>()
  return {
    ...actual,
    geocodeQuery: geocodeQueryMock,
    verifyPlaceLocation: verifyPlaceLocationMock,
  }
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

  it("locates each candidate at its SIGHT, verified against the base town", async () => {
    createMock.mockReset()
    createMock.mockResolvedValueOnce(textResponse(RECORDED_HIGHLIGHTS))
    geocodeQueryMock.mockReset()
    geocodeQueryMock
      .mockResolvedValueOnce({ lat: 61.1153, lng: 10.4662 })
      .mockResolvedValueOnce({ lat: 62.1008, lng: 7.2064 })
    verifyPlaceLocationMock.mockReset()
    verifyPlaceLocationMock
      .mockResolvedValueOnce({
        name: 'Hunderfossen Eventyrpark',
        lat: 61.2426,
        lng: 10.4185,
      })
      .mockResolvedValueOnce({
        name: 'Geiranger Skywalk - Dalsnibba',
        lat: 62.0433,
        lng: 7.2686,
      })

    const { generateRegionHighlights } = await import('./planTrip.js')
    const highlights = await generateRegionHighlights({
      settings: SETTINGS_WITH_START,
      notesFreeText: '',
    })

    const [hunderfossen, skywalk] = highlights.regions[0].candidateStops
    // The sight's own coordinates, not the town's — the pin points at the
    // thing the traveler is deciding on.
    expect(hunderfossen).toMatchObject({
      town: 'Lillehammer',
      lat: 61.2426,
      lng: 10.4185,
      // Places' spelling replaces Claude's, which is what gives a sight one
      // stable identity across repeated curation passes.
      sight: 'Hunderfossen Eventyrpark',
    })
    expect(skywalk.lat).toBe(62.0433)

    // The town is looked up first, biased near the trip's start point…
    expect(geocodeQueryMock).toHaveBeenCalledWith('Lillehammer, NO', {
      name: 'Oslo, Norway',
      lat: 59.9139,
      lng: 10.7522,
    })
    // …and the sight is then checked against that town, by name and distance.
    expect(verifyPlaceLocationMock).toHaveBeenCalledWith(
      'Hunderfossen Familiepark, Lillehammer, NO',
      'Hunderfossen Familiepark',
      { lat: 61.1153, lng: 10.4662 },
      30,
    )
  })

  // The Helsingør-dinner-stop-in-Greece failure, applied to curation: a
  // sight Places cannot find near the town it was claimed to be near is
  // dropped, not pinned wherever the best namesake happens to be.
  it('leaves a sight it cannot verify without coordinates, rather than guessing', async () => {
    createMock.mockReset()
    createMock.mockResolvedValueOnce(textResponse(RECORDED_HIGHLIGHTS))
    geocodeQueryMock.mockReset()
    geocodeQueryMock.mockResolvedValue({ lat: 61.1153, lng: 10.4662 })
    verifyPlaceLocationMock.mockReset()
    verifyPlaceLocationMock.mockResolvedValue(null)

    const { generateRegionHighlights } = await import('./planTrip.js')
    const highlights = await generateRegionHighlights({
      settings: SETTINGS_WITH_START,
      notesFreeText: '',
    })

    const [hunderfossen] = highlights.regions[0].candidateStops
    // Everything else survives — only the coordinates are missing, which is
    // what buildExploreCandidateWrites drops on.
    expect(hunderfossen.sight).toBe('Hunderfossen Familiepark')
    expect(hunderfossen.priority).toBe('must-see')
    expect(hunderfossen.lat).toBeUndefined()
    expect(hunderfossen.lng).toBeUndefined()
  })

  it('degrades to a candidate with no coordinates when the lookup throws (e.g. no Places key)', async () => {
    createMock.mockReset()
    createMock.mockResolvedValueOnce(textResponse(RECORDED_HIGHLIGHTS))
    geocodeQueryMock.mockReset()
    geocodeQueryMock.mockRejectedValue(
      new Error('GOOGLE_PLACES_API_KEY is not configured'),
    )
    verifyPlaceLocationMock.mockReset()

    const { generateRegionHighlights } = await import('./planTrip.js')
    const highlights = await generateRegionHighlights({
      settings: SETTINGS_WITH_START,
      notesFreeText: '',
    })

    const [hunderfossen] = highlights.regions[0].candidateStops
    expect(hunderfossen.town).toBe('Lillehammer')
    expect(hunderfossen.why).toContain('Olympic')
    expect(hunderfossen.lat).toBeUndefined()
  })

  it('does not even look for the sight when its base town does not resolve', async () => {
    createMock.mockReset()
    createMock.mockResolvedValueOnce(textResponse(RECORDED_HIGHLIGHTS))
    geocodeQueryMock.mockReset()
    geocodeQueryMock.mockResolvedValue(null)
    verifyPlaceLocationMock.mockReset()

    const { generateRegionHighlights } = await import('./planTrip.js')
    const highlights = await generateRegionHighlights({
      settings: SETTINGS_WITH_START,
      notesFreeText: '',
    })

    // With no anchor there is nothing to check a match against, and an
    // unchecked match is exactly the wrong-country pin this guards against.
    expect(verifyPlaceLocationMock).not.toHaveBeenCalled()
    expect(highlights.regions[0].candidateStops[0].lat).toBeUndefined()
  })

  // The prompt encourages several sights to share one base town, and that
  // town is the anchor every one of them is verified against — so without
  // this, a pass proposing three things to do around one town pays for three
  // identical geocodes of it, on the call the traveler is waiting for.
  it('geocodes a shared base town once, however many sights name it', async () => {
    createMock.mockReset()
    createMock.mockResolvedValueOnce(
      textResponse(`{
        "regions": [
          {
            "region": "North Zealand",
            "country": "DK",
            "reasoning": "r",
            "candidateStops": [
              { "sight": "Kronborg Castle", "town": "Helsingør", "country": "DK", "why": "w", "priority": "must-see" },
              { "sight": "M/S Maritime Museum", "town": "Helsingør", "country": "DK", "why": "w", "priority": "worth-a-detour" }
            ]
          }
        ]
      }`),
    )
    geocodeQueryMock.mockReset()
    geocodeQueryMock.mockResolvedValue({ lat: 56.03, lng: 12.61 })
    verifyPlaceLocationMock.mockReset()
    verifyPlaceLocationMock.mockImplementation((_query: string, name: string) =>
      Promise.resolve({ name, lat: 56.04, lng: 12.62 }),
    )

    const { generateRegionHighlights } = await import('./planTrip.js')
    await generateRegionHighlights({
      settings: SETTINGS_WITH_START,
      notesFreeText: '',
    })

    expect(geocodeQueryMock).toHaveBeenCalledTimes(1)
    expect(verifyPlaceLocationMock).toHaveBeenCalledTimes(2)
  })

  it('spends nothing on a candidate that already carries coordinates', async () => {
    createMock.mockReset()
    createMock.mockResolvedValueOnce(
      textResponse(`{
        "regions": [
          {
            "region": "North Zealand",
            "country": "DK",
            "reasoning": "r",
            "candidateStops": [
              { "sight": "Kronborg Castle", "town": "Helsingør", "country": "DK", "why": "w", "priority": "must-see", "lat": 56.039, "lng": 12.621 },
              { "sight": "M/S Maritime Museum", "town": "Helsingør", "country": "DK", "why": "w", "priority": "worth-a-detour" }
            ]
          }
        ]
      }`),
    )
    geocodeQueryMock.mockReset()
    geocodeQueryMock.mockResolvedValue({ lat: 56.03, lng: 12.61 })
    verifyPlaceLocationMock.mockReset()
    verifyPlaceLocationMock.mockImplementation((_query: string, name: string) =>
      Promise.resolve({ name, lat: 56.04, lng: 12.62 }),
    )

    const { generateRegionHighlights } = await import('./planTrip.js')
    const highlights = await generateRegionHighlights({
      settings: SETTINGS_WITH_START,
      notesFreeText: '',
    })

    // Only the unlocated one is looked up, and the located one keeps the
    // coordinates it arrived with rather than being re-resolved.
    expect(verifyPlaceLocationMock).toHaveBeenCalledTimes(1)
    expect(highlights.regions[0].candidateStops[0].lat).toBe(56.039)
  })

  it('skips location lookups entirely when the trip has no start point to bias from', async () => {
    createMock.mockReset()
    createMock.mockResolvedValueOnce(textResponse(RECORDED_HIGHLIGHTS))
    geocodeQueryMock.mockReset()
    verifyPlaceLocationMock.mockReset()

    const { generateRegionHighlights } = await import('./planTrip.js')
    const highlights = await generateRegionHighlights({
      settings: {} as never,
      notesFreeText: '',
    })

    expect(geocodeQueryMock).not.toHaveBeenCalled()
    expect(verifyPlaceLocationMock).not.toHaveBeenCalled()
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

// The shape of the response that broke "Generate overview" in production on
// 2026-08-12 (trip "Luxemburg", both attempts, 500 to the traveler): a
// complete curation whose final candidate is a key with no value, followed
// by correctly-balanced closing braces. Taken from the Cloud Logging entry
// rather than invented — `"why "` with nothing after it is exactly what
// Claude emitted, and it is what made JSON.parse discard the whole
// 5,609-character answer.
const HIGHLIGHTS_WITH_BROKEN_TAIL = `{
  "regions": [
    {
      "region": "Danish crossing / Little Belt & Zealand transit",
      "country": "DK",
      "reasoning": "Mostly transit, but the belt bridges are a genuine sight in themselves.",
      "candidateStops": [
        { "sight": "Lillebæltsbroen", "town": "Middelfart", "country": "DK", "why": "Bridge views over the Little Belt, and a harbour the kids can swim off.", "priority": "worth-a-detour" },
        { "sight": "Ribe VikingeCenter", "town": "Ribe", "country": "DK", "why": "Denmark's oldest town: cobbled lanes, storks on the rooftops, a Viking museum built for children.", "priority": "must-see" },
        {
          "sight": "Ch\u00e2teau de Bouillon",
          "town": "Bouillon",
          "country": "BE",
          "why "
        }
      ]
    }
  ]
}`

describe('salvageJsonPrefix', () => {
  it('cuts back to the last complete element of the production failure', async () => {
    const { salvageJsonPrefix } = await import('./planTrip.js')
    const repaired = salvageJsonPrefix(HIGHLIGHTS_WITH_BROKEN_TAIL)

    expect(repaired).not.toBeNull()
    const parsed = JSON.parse(repaired as string)
    // Everything Claude finished writing survives; only the half-written
    // trailing candidate is lost.
    expect(
      parsed.regions[0].candidateStops.map((s: { sight: string }) => s.sight),
    ).toEqual(['Lillebæltsbroen', 'Ribe VikingeCenter'])
  })

  it('leaves valid JSON exactly as it found it', async () => {
    const { salvageJsonPrefix } = await import('./planTrip.js')
    const valid = '{"regions": [{"region": "x", "candidateStops": []}]}'

    expect(JSON.parse(salvageJsonPrefix(valid) as string)).toEqual(
      JSON.parse(valid),
    )
  })

  // The other way a response stops being parseable: the JSON is complete and
  // Claude then keeps talking, despite the prompt asking for JSON only.
  it('drops trailing prose after the closing brace', async () => {
    const { salvageJsonPrefix } = await import('./planTrip.js')
    const withProse = '{"regions": []}\n\nLet me know if you would like more!'

    expect(JSON.parse(salvageJsonPrefix(withProse) as string)).toEqual({
      regions: [],
    })
  })

  // Braces and quotes inside a "why" sentence are content, not structure — a
  // scanner that ignored string state would cut in the middle of one.
  it('does not mistake braces or escaped quotes inside a string for structure', async () => {
    const { salvageJsonPrefix } = await import('./planTrip.js')
    const tricky = JSON.stringify({
      regions: [
        {
          region: 'Wallonia',
          country: 'BE',
          reasoning: 'A note with a } brace and a "quoted" phrase.',
          candidateStops: [
            {
              town: 'Dinant',
              country: 'BE',
              why: 'A citadel {above} the Meuse.',
              priority: 'must-see',
            },
          ],
        },
      ],
    })

    expect(JSON.parse(salvageJsonPrefix(`${tricky} trailing`) as string)).toEqual(
      JSON.parse(tricky),
    )
  })

  it('returns null when there is no complete element to fall back to', async () => {
    const { salvageJsonPrefix } = await import('./planTrip.js')

    expect(salvageJsonPrefix('not json at all')).toBeNull()
    expect(salvageJsonPrefix('{"regions": [{"region": "x"')).toBeNull()
    // A mismatched closer means the nesting itself is untrustworthy, so no
    // cut point recorded before it can be relied on either.
    expect(salvageJsonPrefix('{"regions": [{"region": "x"}]]}')).toBeNull()
  })
})

describe('salvage on the highlights call', () => {
  // The end-to-end regression for 2026-08-12: with both attempts returning
  // the broken response, the run used to throw and the callable 500'd after
  // paying for two Claude calls. The complete candidates are kept now.
  it('returns the complete candidates when both attempts come back malformed', async () => {
    createMock.mockReset()
    createMock.mockResolvedValue(textResponse(HIGHLIGHTS_WITH_BROKEN_TAIL))

    const { generateRegionHighlights } = await import('./planTrip.js')
    const highlights = await generateRegionHighlights({
      settings: {} as never,
      notesFreeText: '',
    })

    expect(createMock).toHaveBeenCalledTimes(2)
    expect(highlights.regions[0].candidateStops.map((s) => s.sight)).toEqual([
      'Lillebæltsbroen',
      'Ribe VikingeCenter',
    ])
  })

  it('still throws when the last response has no valid prefix to keep', async () => {
    createMock.mockReset()
    createMock.mockResolvedValue(textResponse('still not valid json'))

    const { generateRegionHighlights } = await import('./planTrip.js')
    await expect(
      generateRegionHighlights({ settings: {} as never, notesFreeText: '' }),
    ).rejects.toThrow()
    expect(createMock).toHaveBeenCalledTimes(2)
  })

  // Salvage is deliberately limited to the curation pass. A truncated
  // outline would parse into a shorter trip that never reaches the finish
  // point, and a truncated chunk detail into a day with no plan — both are
  // worse than failing loudly, so neither call gets a salvage path.
  it('does not salvage a truncated outline, which would silently shorten the trip', async () => {
    createMock.mockReset()
    const fullOutline = JSON.parse(
      RECORDED_OUTLINE.replace(/```json|```/g, ''),
    ) as { days: unknown[] }
    // Broken in exactly the way the highlights response was — a complete
    // first day, then a second day cut off at a key with no value. Salvage
    // WOULD recover the first day here; the assertion is that the outline
    // call never offers it that, because a one-day plan for a two-day trip
    // is a wrong answer rather than a partial one.
    const brokenOutline = `{"days":[${JSON.stringify(fullOutline.days[0])},{"index":1,"date" }]}`
    expect(
      (await import('./planTrip.js')).salvageJsonPrefix(brokenOutline),
    ).not.toBeNull()
    createMock
      .mockResolvedValueOnce(textResponse(RECORDED_HIGHLIGHTS))
      .mockResolvedValue(textResponse(brokenOutline))

    const { planTrip } = await import('./planTrip.js')
    await expect(
      planTrip({ settings: {} as never, notesFreeText: '' }),
    ).rejects.toThrow()
  })
})
