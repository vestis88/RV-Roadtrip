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
    { name: 'Maihaugen Open-Air Museum', town: 'Lillehammer', category: 'museum', kidFriendly: true, blurb: 'A hidden-gem open-air museum the kids will love.' },
    { name: 'Lysgårdsbakkene Ski Jumping Arena', town: 'Lillehammer', category: 'sight', kidFriendly: true, blurb: 'Olympic ski jump with a viewing platform.' },
    { name: 'Hunderfossen Family Park', town: 'Øyer', category: 'playground', kidFriendly: true, blurb: 'A classic family theme park just outside town.' },
    { name: 'Mjøsa lakeside walk', town: 'Lillehammer', category: 'hike', kidFriendly: true, blurb: 'A gentle lakeside stroll with picnic spots.' },
    { name: 'Lillehammer Art Museum', town: 'Lillehammer', category: 'sight', kidFriendly: false, blurb: 'A striking modern building with Norwegian art.' },
  ]
}

function restaurants() {
  return [
    { name: 'Nikkers', town: 'Lillehammer', meal: 'breakfast', cuisine: 'Norwegian', blurb: 'Cozy breakfast spot near the river.' },
    { name: 'Bakeriet i Lillehammer', town: 'Lillehammer', meal: 'breakfast', cuisine: 'Bakery', blurb: 'Local bakery with fresh pastries.' },
    { name: 'Cafe Klosteret', town: 'Lillehammer', meal: 'breakfast', cuisine: 'Cafe', blurb: 'Relaxed café in a historic building.' },
    { name: 'Vertshuset', town: 'Lillehammer', meal: 'lunch', cuisine: 'Norwegian', blurb: 'Traditional lunch fare in the old town.' },
    { name: 'Svare & Berg', town: 'Lillehammer', meal: 'lunch', cuisine: 'Contemporary', blurb: 'Modern bistro with a seasonal menu.' },
    { name: 'Nikkers Lunsj', town: 'Lillehammer', meal: 'lunch', cuisine: 'Norwegian', blurb: 'Same cozy spot, hearty midday plates.' },
    { name: 'Bryggerikjelleren', town: 'Lillehammer', meal: 'dinner', cuisine: 'Norwegian', blurb: 'Cozy cellar restaurant near the river.' },
    { name: 'Egon Lillehammer', town: 'Lillehammer', meal: 'dinner', cuisine: 'Family', blurb: 'Reliable family-friendly chain restaurant.' },
    { name: 'Sushi Bar Lillehammer', town: 'Lillehammer', meal: 'dinner', cuisine: 'Japanese', blurb: 'A change of pace with fresh sushi.' },
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

  it('throws on a response that violates the schema', () => {
    expect(() => parseRegionHighlights('{"regions": []}')).toThrow()
    expect(() => parseRegionHighlights('{"regions": [{"region": "x"}]}')).toThrow()
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
    const oneBased = RECORDED_OUTLINE.replace('"index": 0', '"index": 1').replace(
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
  })

  it('splits a longer route into multiple chunk calls and reassembles them in order', async () => {
    createMock.mockReset()
    const tenDayOutline = {
      days: Array.from({ length: 10 }, (_, index) => ({
        index,
        date: `2026-07-${10 + index}`,
        type: 'drive',
        overnight: { name: `Stop ${index}`, town: `Town ${index}`, country: 'NO' },
        drive: { fromTown: `Town ${index - 1}`, toTown: `Town ${index}`, slot: 'morning' },
        highlightReason: `Reason for stop ${index}.`,
      })),
    }
    createMock
      .mockResolvedValueOnce(textResponse(RECORDED_HIGHLIGHTS))
      .mockResolvedValueOnce(textResponse(JSON.stringify(tenDayOutline)))
      // CHUNK_SIZE is 7, so 10 days split into a 7-day and a 3-day call.
      .mockResolvedValueOnce(textResponse(dayDetailResponseFor([0, 1, 2, 3, 4, 5, 6])))
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
    expect(result.days.map((d) => d.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(result.days[9].overnight.name).toBe('Stop 9')
    expect(onProgress).toHaveBeenCalledWith({ phase: 'highlights' })
    expect(onProgress).toHaveBeenCalledWith({ phase: 'outline' })
    expect(onProgress).toHaveBeenCalledWith({ phase: 'detail', chunkIndex: 1, chunkCount: 2 })
    expect(onProgress).toHaveBeenCalledWith({ phase: 'detail', chunkIndex: 2, chunkCount: 2 })
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
