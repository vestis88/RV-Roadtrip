import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeRouteLeg } from './routesApi.js'

const OSLO = { name: 'Oslo', lat: 59.9139, lng: 10.7522 }
const ROME = { name: 'Rome', lat: 41.9028, lng: 12.4964 }

describe('computeRouteLeg', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('falls back to a haversine-based estimate when no API key is configured', async () => {
    const leg = await computeRouteLeg(OSLO, ROME)
    expect(leg.distanceKm).toBeGreaterThan(0)
    expect(leg.durationMin).toBeGreaterThan(0)
  })

  it('parses a mocked Routes API response when a key is configured', async () => {
    vi.stubEnv('GOOGLE_ROUTES_API_KEY', 'test-key')
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        routes: [
          {
            distanceMeters: 2_700_000,
            duration: '97200s',
            polyline: { encodedPolyline: 'abc123' },
          },
        ],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const leg = await computeRouteLeg(OSLO, ROME)

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(leg.distanceKm).toBe(2700)
    expect(leg.durationMin).toBe(1620)
    expect(leg.polyline).toBe('abc123')
  })
})

