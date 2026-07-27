import { afterEach, describe, expect, it, vi } from 'vitest'
import { searchStellplatzCandidates } from './overpassApi.js'

const NEAR = { lat: 61.1, lng: 10.5 }

function jsonResponse(body: unknown, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })
}

describe('searchStellplatzCandidates', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads coordinates from a node directly and from a way via its center', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      jsonResponse({
        elements: [
          { type: 'node', id: 1, lat: 61.2, lon: 10.6, tags: { name: 'Node stopover' } },
          {
            type: 'way',
            id: 2,
            center: { lat: 61.3, lon: 10.7 },
            tags: { name: 'Way stopover' },
          },
        ],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const candidates = await searchStellplatzCandidates(NEAR, 'NO', 5)

    expect(candidates).toHaveLength(2)
    expect(candidates[0]).toMatchObject({
      name: 'Node stopover',
      type: 'stellplatz',
      lat: 61.2,
      lng: 10.6,
      country: 'NO',
      source: 'osm',
    })
    expect(candidates[1]).toMatchObject({
      name: 'Way stopover',
      lat: 61.3,
      lng: 10.7,
    })
  })

  it('caps results at the requested limit', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      jsonResponse({
        elements: Array.from({ length: 5 }, (_, i) => ({
          type: 'node',
          id: i,
          lat: 61 + i,
          lon: 10 + i,
          tags: { name: `Stop ${i}` },
        })),
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const candidates = await searchStellplatzCandidates(NEAR, 'NO', 2)
    expect(candidates).toHaveLength(2)
  })

  it('falls back to an unnamed label when the OSM element has no name tag', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      jsonResponse({
        elements: [{ type: 'node', id: 1, lat: 61.2, lon: 10.6 }],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const candidates = await searchStellplatzCandidates(NEAR, 'NO', 5)
    expect(candidates[0].name).toBe('Unnamed motorhome stopover')
  })

  it('sends the correct query tags in the request body', async () => {
    const fetchMock = vi.fn().mockImplementation(() => jsonResponse({ elements: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await searchStellplatzCandidates(NEAR, 'NO', 5)

    const [, requestInit] = fetchMock.mock.calls[0]
    const body = decodeURIComponent(String(requestInit.body).replace(/^data=/, ''))
    expect(body).toContain('tourism"="caravan_site"')
    expect(body).toContain('caravan_site"="motorhome_stopover"')
    expect(body).toContain(`${NEAR.lat}`)
    expect(body).toContain(`${NEAR.lng}`)
  })

  it('throws with a descriptive error on a non-ok response', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => jsonResponse({}, false, 429))
    vi.stubGlobal('fetch', fetchMock)

    await expect(searchStellplatzCandidates(NEAR, 'NO', 5)).rejects.toThrow(
      /Overpass query failed with 429/,
    )
  })
})
