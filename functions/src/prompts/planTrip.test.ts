import { describe, expect, it, vi } from 'vitest'
import { parsePlanTripSkeleton } from './planTrip.js'

const RECORDED_RESPONSE = `\`\`\`json
{
  "days": [
    {
      "index": 0,
      "date": "2026-07-10",
      "type": "drive",
      "overnight": {
        "name": "Lillehammer Camping",
        "town": "Lillehammer",
        "country": "NO",
        "campsiteSuggestion": "Lillehammer Camping"
      },
      "drive": { "fromTown": "Oslo", "toTown": "Lillehammer", "slot": "morning" },
      "summary": "Easy first day north along the Mjøsa lake.",
      "activities": [
        { "name": "Maihaugen Open-Air Museum", "town": "Lillehammer", "category": "museum", "kidFriendly": true, "blurb": "A hidden-gem open-air museum the kids will love." },
        { "name": "Lysgårdsbakkene Ski Jumping Arena", "town": "Lillehammer", "category": "sight", "kidFriendly": true, "blurb": "Olympic ski jump with a viewing platform." },
        { "name": "Hunderfossen Family Park", "town": "Øyer", "category": "playground", "kidFriendly": true, "blurb": "A classic family theme park just outside town." },
        { "name": "Mjøsa lakeside walk", "town": "Lillehammer", "category": "hike", "kidFriendly": true, "blurb": "A gentle lakeside stroll with picnic spots." },
        { "name": "Lillehammer Art Museum", "town": "Lillehammer", "category": "sight", "kidFriendly": false, "blurb": "A striking modern building with Norwegian art." }
      ],
      "restaurants": [
        { "name": "Nikkers", "town": "Lillehammer", "meal": "breakfast", "cuisine": "Norwegian", "blurb": "Cozy breakfast spot near the river." },
        { "name": "Bakeriet i Lillehammer", "town": "Lillehammer", "meal": "breakfast", "cuisine": "Bakery", "blurb": "Local bakery with fresh pastries." },
        { "name": "Cafe Klosteret", "town": "Lillehammer", "meal": "breakfast", "cuisine": "Cafe", "blurb": "Relaxed café in a historic building." },
        { "name": "Vertshuset", "town": "Lillehammer", "meal": "lunch", "cuisine": "Norwegian", "blurb": "Traditional lunch fare in the old town." },
        { "name": "Svare & Berg", "town": "Lillehammer", "meal": "lunch", "cuisine": "Contemporary", "blurb": "Modern bistro with a seasonal menu." },
        { "name": "Nikkers Lunsj", "town": "Lillehammer", "meal": "lunch", "cuisine": "Norwegian", "blurb": "Same cozy spot, hearty midday plates." },
        { "name": "Bryggerikjelleren", "town": "Lillehammer", "meal": "dinner", "cuisine": "Norwegian", "blurb": "Cozy cellar restaurant near the river." },
        { "name": "Egon Lillehammer", "town": "Lillehammer", "meal": "dinner", "cuisine": "Family", "blurb": "Reliable family-friendly chain restaurant." },
        { "name": "Sushi Bar Lillehammer", "town": "Lillehammer", "meal": "dinner", "cuisine": "Japanese", "blurb": "A change of pace with fresh sushi." }
      ]
    }
  ]
}
\`\`\``

describe('parsePlanTripSkeleton', () => {
  it('parses a recorded Claude response into a valid skeleton', () => {
    const skeleton = parsePlanTripSkeleton(RECORDED_RESPONSE)
    expect(skeleton.days).toHaveLength(1)
    expect(skeleton.days[0].activities).toHaveLength(5)
    expect(skeleton.days[0].restaurants).toHaveLength(9)
    expect(skeleton.days[0].overnight.name).toBe('Lillehammer Camping')
  })

  it('throws on a response that violates the schema', () => {
    expect(() => parsePlanTripSkeleton('{"days": []}')).toThrow()
    expect(() =>
      parsePlanTripSkeleton('{"days": [{"index": 0}]}'),
    ).toThrow()
  })
})

const createMock = vi.fn()

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: createMock }
  },
}))

describe('planTrip retry behavior', () => {
  it('retries once on a schema failure and succeeds on the second attempt', async () => {
    createMock.mockReset()
    createMock
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'not valid json' }],
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: RECORDED_RESPONSE }],
      })

    const { planTrip } = await import('./planTrip.js')
    const result = await planTrip({
      settings: {} as never,
      notesFreeText: 'no allergies',
    })

    expect(createMock).toHaveBeenCalledTimes(2)
    expect(result.days).toHaveLength(1)
  })

  it('throws after the retry also fails schema validation', async () => {
    createMock.mockReset()
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: 'still not valid json' }],
    })

    const { planTrip } = await import('./planTrip.js')
    await expect(
      planTrip({ settings: {} as never, notesFreeText: '' }),
    ).rejects.toThrow()

    expect(createMock).toHaveBeenCalledTimes(2)
  })
})
