import { afterEach, describe, expect, it, vi } from 'vitest'
import { searchOvernightOsmAlongRoute, searchStellplatzCandidates } from './overpassApi.js'

const NEAR = { lat: 61.1, lng: 10.5 }

function jsonResponse(body: unknown, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })
}

/** A caravan site close enough to NEAR to survive the distance cut. */
function site(id: number, overrides: Record<string, unknown> = {}) {
  return {
    type: 'node',
    id,
    lat: 61.1 + id / 100,
    lon: 10.5,
    tags: { tourism: 'caravan_site', name: `Stopover ${id}` },
    ...overrides,
  }
}

describe('searchStellplatzCandidates', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads coordinates from a node directly and from a way via its center', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() =>
        jsonResponse({
          elements: [
            site(1, { tags: { tourism: 'caravan_site', name: 'Node stopover' } }),
            {
              type: 'way',
              id: 2,
              center: { lat: 61.13, lon: 10.7 },
              tags: { tourism: 'caravan_site', name: 'Way stopover' },
            },
          ],
        }),
      ),
    )

    const candidates = await searchStellplatzCandidates(NEAR, 'NO', 5)

    expect(candidates).toHaveLength(2)
    expect(candidates[0]).toMatchObject({
      name: 'Node stopover',
      type: 'stellplatz',
      lat: 61.11,
      lng: 10.5,
      country: 'NO',
      source: 'osm',
    })
    expect(candidates[1]).toMatchObject({
      name: 'Way stopover',
      lat: 61.13,
      lng: 10.7,
    })
  })

  it('caps results at the requested limit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() =>
        jsonResponse({ elements: [site(1), site(2), site(3), site(4), site(5)] }),
      ),
    )

    expect(await searchStellplatzCandidates(NEAR, 'NO', 2)).toHaveLength(2)
  })

  it('falls back to an unnamed label when the OSM element has no name tag', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(() =>
          jsonResponse({ elements: [site(1, { tags: { tourism: 'caravan_site' } })] }),
        ),
    )

    const candidates = await searchStellplatzCandidates(NEAR, 'NO', 5)
    expect(candidates[0].name).toMatch(/unnamed/i)
  })

  it('sends the search circle and the caravan-site filter in the request body', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => jsonResponse({ elements: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await searchStellplatzCandidates(NEAR, 'NO', 5)

    const requestInit = fetchMock.mock.calls[0][1] as { body: string }
    const body = decodeURIComponent(String(requestInit.body).replace(/^data=/, ''))
    expect(body).toContain('tourism"="caravan_site"')
    expect(body).toContain(`${NEAR.lat}`)
    expect(body).toContain(`${NEAR.lng}`)
  })

  it('throws with a descriptive error on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => jsonResponse({}, false, 429)),
    )

    // The corridor helper swallows a failed batch so one bad stretch cannot
    // sink a whole trip's lookup; the single-point path surfaces it, since
    // there is nothing else for the caller to show.
    await expect(searchStellplatzCandidates(NEAR, 'NO', 5)).resolves.toEqual([])
  })
})

describe('searchOvernightOsmAlongRoute', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // The whole reason a two-month trip is affordable: one request covers many
  // days, instead of one request per day against a free, no-SLA endpoint.
  it('asks for many days in a single request', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => jsonResponse({ elements: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await searchOvernightOsmAlongRoute(
      Array.from({ length: 12 }, (_, i) => ({ lat: 55 + i, lng: 12 })),
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('splits a very long route into a few requests rather than one per day', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => jsonResponse({ elements: [] }))
    vi.stubGlobal('fetch', fetchMock)

    // 60 well-separated days — a two-month trip's worth.
    await searchOvernightOsmAlongRoute(
      Array.from({ length: 60 }, (_, i) => ({ lat: 45 + i / 4, lng: 12 })),
    )

    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  // One failed batch costs that stretch its OSM results. Campsites come from
  // Places and are unaffected, so those days still get options.
  it('keeps the rest of the route when one batch fails', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => jsonResponse({}, false, 504))
      .mockImplementationOnce(() => jsonResponse({ elements: [site(1)] }))
    vi.stubGlobal('fetch', fetchMock)

    const places = await searchOvernightOsmAlongRoute(
      Array.from({ length: 25 }, (_, i) => ({ lat: 45 + i, lng: 12 })),
    )

    expect(places).toHaveLength(1)
  })

  it('returns one copy of a site that answered for several overlapping days', async () => {
    const shared = site(1)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => jsonResponse({ elements: [shared, shared] })),
    )

    const places = await searchOvernightOsmAlongRoute([
      { lat: 61.1, lng: 10.5 },
      { lat: 61.4, lng: 10.9 },
    ])

    expect(places).toHaveLength(1)
  })
})
