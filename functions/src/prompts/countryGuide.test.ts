import { describe, expect, it, vi } from 'vitest'
import { parseCountryGuideOutput } from './countryGuide.js'

const RECORDED_RESPONSE = `\`\`\`json
{
  "name": "Norway",
  "drivingRules": ["Headlights on at all times", "Studded tires allowed Nov-Apr"],
  "campingRules": ["Campsites require advance booking in July"],
  "freeCampingRules": ["Allemannsretten allows free camping on uncultivated land for up to two nights"],
  "roadFees": {
    "summary": "Toll roads around major cities, no nationwide vignette.",
    "howToPay": "AutoPASS, billed automatically via license plate.",
    "vignetteUrl": "https://www.autopass.no"
  },
  "speedLimits": {
    "urban": "50 km/h",
    "rural": "80 km/h",
    "motorway": "90 km/h for vehicles over 3,500 kg registered as car",
    "notes": "As of 2026-07-06, check local signage for RV-specific limits."
  },
  "lpgInfo": {
    "adapterNeeded": "Norwegian bayonet adapter",
    "commonBrands": ["AGA", "Kosan Gas"],
    "tips": "Refill stations are less common outside cities; carry a spare bottle."
  }
}
\`\`\``

describe('parseCountryGuideOutput', () => {
  it('parses a recorded Claude response with all six sections populated', () => {
    const guide = parseCountryGuideOutput(RECORDED_RESPONSE)
    expect(guide.name).toBe('Norway')
    expect(guide.drivingRules.length).toBeGreaterThan(0)
    expect(guide.campingRules.length).toBeGreaterThan(0)
    expect(guide.freeCampingRules.length).toBeGreaterThan(0)
    expect(guide.roadFees.summary).toBeTruthy()
    expect(guide.speedLimits.motorway).toBeTruthy()
    expect(guide.lpgInfo.adapterNeeded).toBeTruthy()
  })

  it('throws on a response missing a required section', () => {
    expect(() => parseCountryGuideOutput('{"name": "Norway"}')).toThrow()
  })
})

const createMock = vi.fn()

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: createMock }
  },
}))

describe('generateCountryGuide retry behavior', () => {
  it('retries once on a schema failure and succeeds on the second attempt', async () => {
    createMock.mockReset()
    createMock
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'not valid json' }],
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: RECORDED_RESPONSE }],
      })

    const { generateCountryGuide } = await import('./countryGuide.js')
    const guide = await generateCountryGuide({
      countryCode: 'NO',
      vehicle: { type: 'RV', weightKg: 3500, registeredAs: 'car' },
    })

    expect(createMock).toHaveBeenCalledTimes(2)
    expect(guide.name).toBe('Norway')
    expect(guide.generatedAt).toBeTruthy()

    // The web_search tool must be offered on every attempt.
    for (const call of createMock.mock.calls) {
      const [params] = call as [{ tools?: { type: string }[] }]
      expect(params.tools?.some((t) => t.type === 'web_search_20260209')).toBe(
        true,
      )
    }
  })
})
