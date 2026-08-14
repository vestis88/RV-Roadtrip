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

  // Regression for the outage of 2026-08-10..13: overpass-api.de answered
  // 406 to every request, and because this path had been routed through the
  // corridor helper (which absorbs a refused batch into an empty list) the
  // callable logged nothing and the traveler saw a picker with no Stellplatz
  // section — identical to "there are none near this town".
  it('rejects rather than reporting no stellplatz when Overpass refuses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => jsonResponse({}, false, 406)),
    )

    await expect(searchStellplatzCandidates(NEAR, 'NO', 5)).rejects.toThrow(
      /406/,
    )
  })

  it('names every endpoint it tried, and its status, when all of them refuse', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => jsonResponse({}, false, 406)),
    )

    // The diagnosis is "which host turned us down, and how" — a bare "OSM
    // returned nothing" is what kept this invisible for three days.
    await expect(searchStellplatzCandidates(NEAR, 'NO', 5)).rejects.toThrow(
      /overpass-api\.de.*overpass\.kumi\.systems/s,
    )
  })

  // The whole point of a second endpoint: one instance blocking us must not
  // empty the Stellplatz section of every day of every trip.
  it('falls back to the mirror when the primary endpoint refuses', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => jsonResponse({}, false, 406))
      .mockImplementationOnce(() => jsonResponse({ elements: [site(1)] }))
    vi.stubGlobal('fetch', fetchMock)

    const candidates = await searchStellplatzCandidates(NEAR, 'NO', 5)

    expect(candidates).toHaveLength(1)
    expect(fetchMock.mock.calls[0][0]).toContain('overpass-api.de')
    expect(fetchMock.mock.calls[1][0]).toContain('overpass.kumi.systems')
  })

  // The actual root cause. Node's global fetch sends `user-agent: node` when
  // nothing sets one, and that is what overpass-api.de's front end answered
  // 406 to; the OSM API usage policy requires an agent that identifies the
  // application and gives its operator a way to make contact.
  it('identifies the application to Overpass', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => jsonResponse({ elements: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await searchStellplatzCandidates(NEAR, 'NO', 5)

    const headers = (fetchMock.mock.calls[0][1] as {
      headers: Record<string, string>
    }).headers
    expect(headers['User-Agent']).toMatch(/RV-Roadtrip/)
    expect(headers['User-Agent']).not.toBe('node')
    // A contact route, which is the part of the policy a bare product name
    // would still be missing.
    expect(headers['User-Agent']).toMatch(/https?:\/\//)
    expect(headers.Accept).toBe('application/json')
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
  it('keeps the rest of the route when one batch fails at every endpoint', async () => {
    // Batch 1 (the first 20 points) is refused wherever it is sent; batch 2
    // answers. Keyed on the query body rather than call order because the
    // batches are issued in parallel and each may be retried on the mirror.
    const fetchMock = vi.fn().mockImplementation((_url: string, init: { body: string }) =>
      init.body.includes(encodeURIComponent('45,12'))
        ? jsonResponse({}, false, 504)
        : jsonResponse({ elements: [site(1)] }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const places = await searchOvernightOsmAlongRoute(
      Array.from({ length: 25 }, (_, i) => ({ lat: 45 + i, lng: 12 })),
    )

    expect(places).toHaveLength(1)
  })

  // The defect that let a total outage run for three days: every batch was
  // refused, each one logged as a lone warning, and the caller got back a
  // plain empty list — the same value a route with genuinely no caravan
  // sites on it produces. "We cannot reach OpenStreetMap" has to be loud and
  // greppable on its own, because it is a statement about our access rather
  // than about the route.
  it('reports an error, not just warnings, when every batch is refused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => jsonResponse({}, false, 406)),
    )
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const places = await searchOvernightOsmAlongRoute(
      Array.from({ length: 25 }, (_, i) => ({ lat: 45 + i, lng: 12 })),
    )

    expect(places).toEqual([])
    expect(error).toHaveBeenCalledTimes(1)
    expect(error.mock.calls[0][0]).toMatch(/UNAVAILABLE/)
    error.mockRestore()
    warn.mockRestore()
  })

  it('says nothing when the route genuinely has no OSM overnight places on it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => jsonResponse({ elements: [] })),
    )
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // An honest empty answer. The whole point of the error above is that this
    // case and a refusal must not look the same.
    expect(
      await searchOvernightOsmAlongRoute([{ lat: 45, lng: 12 }]),
    ).toEqual([])
    expect(error).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    error.mockRestore()
    warn.mockRestore()
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
