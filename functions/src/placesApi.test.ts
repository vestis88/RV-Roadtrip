import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  enrichActivities,
  enrichRestaurantsForMeal,
  findNearbyCampsites,
  type ProposedActivity,
  type ProposedRestaurant,
  verifyPlaceLocation,
} from './placesApi.js'

const NEAR = { lat: 61.1, lng: 10.5 }

let placeCounter = 0
function goodPlace(overrides: Record<string, unknown> = {}) {
  placeCounter += 1
  return {
    id: `place-${placeCounter}`,
    displayName: { text: `Place ${placeCounter}` },
    location: { latitude: 61.1, longitude: 10.5 },
    rating: 4.5,
    userRatingCount: 200,
    googleMapsUri: `https://maps.google.com/?q=place-${placeCounter}`,
    photos: [{ name: `places/place-${placeCounter}/photos/1` }],
    ...overrides,
  }
}

function jsonResponse(body: unknown) {
  return Promise.resolve({
    ok: true,
    json: async () => body,
  })
}

describe('enrichActivities', () => {
  beforeEach(() => {
    placeCounter = 0
    vi.stubEnv('GOOGLE_PLACES_API_KEY', 'test-key')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  const proposed: ProposedActivity[] = Array.from({ length: 5 }, (_, i) => ({
    name: `Attraction ${i}`,
    town: 'Lillehammer',
    category: 'sight',
    kidFriendly: true,
    blurb: 'A nice spot.',
  }))

  it('resolves all 5 proposed activities when each meets the quality bar, plus 2 hidden reserve activities', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => jsonResponse({ places: [goodPlace()] }))
    vi.stubGlobal('fetch', fetchMock)

    const activities = await enrichActivities(proposed, NEAR)

    expect(activities).toHaveLength(7)
    for (const activity of activities) {
      expect(activity.rating).toBeGreaterThanOrEqual(3.8)
      expect(activity.googleMapsUrl).toMatch(/^https:\/\//)
      expect(activity.placeId).toBeDefined()
    }
    const uniqueNames = new Set(activities.map((a) => a.name))
    expect(uniqueNames.size).toBe(7)
    expect(activities.slice(0, 5).every((a) => !a.reserve)).toBe(true)
    expect(activities.slice(5).every((a) => a.reserve === true)).toBe(true)
  })

  it('drops a low-quality match and backfills by category to still return exactly 5 displayed + 2 reserve', async () => {
    const fetchMock = vi
      .fn()
      // item 0: good text-search match
      .mockImplementationOnce(() => jsonResponse({ places: [goodPlace()] }))
      // item 1: text search returns a place below the quality bar
      .mockImplementationOnce(() =>
        jsonResponse({
          places: [goodPlace({ rating: 3.0, userRatingCount: 10 })],
        }),
      )
      // item 1: nearby-search fallback also comes up empty
      .mockImplementationOnce(() => jsonResponse({ places: [] }))
      // remaining items (2, 3, 4), the backfill to 5, and the 2 reserve slots
      .mockImplementation(() => jsonResponse({ places: [goodPlace()] }))
    vi.stubGlobal('fetch', fetchMock)

    const activities = await enrichActivities(proposed, NEAR)

    expect(activities).toHaveLength(7)
    const uniqueNames = new Set(activities.map((a) => a.name))
    expect(uniqueNames.size).toBe(7)
    expect(activities.filter((a) => a.reserve).length).toBe(2)
  })

  it('throws when the Places API key is not configured', async () => {
    vi.unstubAllEnvs()
    await expect(enrichActivities(proposed, NEAR)).rejects.toThrow(
      /GOOGLE_PLACES_API_KEY/,
    )
  })

  // Regression test for a real production 400: the Places API (New) rejects
  // 'point_of_interest' as an includedTypes value for searchNearby (it's a
  // Text-Search-only generic type). The 'other' category's nearby-search
  // fallback must omit includedTypes entirely rather than send it.
  it('omits includedTypes from the nearby-search fallback for the "other" category', async () => {
    const otherProposed: ProposedActivity[] = [
      {
        name: 'Mystery spot',
        town: 'Lillehammer',
        category: 'other',
        kidFriendly: true,
        blurb: 'A curious find.',
      },
    ]
    const fetchMock = vi
      .fn()
      // text search: below quality bar, forces the nearby-search fallback
      .mockImplementationOnce(() =>
        jsonResponse({ places: [goodPlace({ rating: 3.0, userRatingCount: 10 })] }),
      )
      .mockImplementationOnce(() => jsonResponse({ places: [goodPlace()] }))
      // remaining backfill attempts (only 1 of 5 activities was proposed)
      .mockImplementation(() => jsonResponse({ places: [goodPlace()] }))
    vi.stubGlobal('fetch', fetchMock)

    const activities = await enrichActivities(otherProposed, NEAR)

    expect(activities.length).toBeGreaterThanOrEqual(1)
    const nearbySearchCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('searchNearby'),
    )
    expect(nearbySearchCall).toBeDefined()
    const body = JSON.parse(nearbySearchCall![1].body as string) as Record<string, unknown>
    expect(body).not.toHaveProperty('includedTypes')
  })
})

describe('enrichRestaurantsForMeal', () => {
  beforeEach(() => {
    placeCounter = 0
    vi.stubEnv('GOOGLE_PLACES_API_KEY', 'test-key')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  const proposed: ProposedRestaurant[] = Array.from({ length: 3 }, (_, i) => ({
    name: `Restaurant ${i}`,
    town: 'Lillehammer',
    meal: 'dinner' as const,
    blurb: 'Good food.',
  }))

  it('resolves exactly 3 displayed restaurants for a meal plus 1 hidden reserve, each with rating, a maps link, and a photo', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => jsonResponse({ places: [goodPlace()] }))
    vi.stubGlobal('fetch', fetchMock)

    const excludeIds = new Set<string>()
    const restaurants = await enrichRestaurantsForMeal(
      proposed,
      'dinner',
      NEAR,
      excludeIds,
    )

    expect(restaurants).toHaveLength(4)
    for (const restaurant of restaurants) {
      expect(restaurant.rating).toBeGreaterThanOrEqual(3.8)
      expect(restaurant.googleMapsUrl).toMatch(/^https:\/\//)
      // Regression: restaurants used to be built without photoUrl at all
      // (only activities carried it through), so every meal card silently
      // rendered without a photo.
      expect(restaurant.photoUrl).toMatch(/^https:\/\//)
      expect(restaurant.meal).toBe('dinner')
      expect(restaurant.placeId).toBeDefined()
    }
    expect(restaurants.slice(0, 3).every((r) => !r.reserve)).toBe(true)
    expect(restaurants[3].reserve).toBe(true)
  })

  it('never resolves a place already excluded by an earlier meal', async () => {
    // A finite, fixed pool returned for every search call (regardless of
    // query) — this is what makes a real collision possible: without a
    // shared excludeIds set, both meals would happily pick the same places.
    const pool = [goodPlace(), goodPlace(), goodPlace(), goodPlace()]
    const fetchMock = vi
      .fn()
      .mockImplementation(() => jsonResponse({ places: pool }))
    vi.stubGlobal('fetch', fetchMock)

    const excludeIds = new Set<string>()
    const lunch = await enrichRestaurantsForMeal(
      proposed,
      'lunch',
      NEAR,
      excludeIds,
    )
    const dinner = await enrichRestaurantsForMeal(
      proposed,
      'dinner',
      NEAR,
      excludeIds,
    )

    const lunchNames = new Set(lunch.map((r) => r.name))
    const dinnerNames = new Set(dinner.map((r) => r.name))
    expect(lunchNames.size).toBeGreaterThan(0)
    for (const name of dinnerNames) {
      expect(lunchNames.has(name)).toBe(false)
    }
  })
})

describe('findNearbyCampsites', () => {
  beforeEach(() => {
    placeCounter = 0
    vi.stubEnv('GOOGLE_PLACES_API_KEY', 'test-key')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('searches rv_park then campground, deduping and capping at the limit', async () => {
    const shared = goodPlace() // same place returned by both searches
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() =>
        jsonResponse({ places: [shared, goodPlace()] }),
      ) // rv_park: 2 results
      .mockImplementationOnce(() =>
        jsonResponse({ places: [shared, goodPlace(), goodPlace()] }),
      ) // campground: shared + 2 more
    vi.stubGlobal('fetch', fetchMock)

    const candidates = await findNearbyCampsites(NEAR, 'NO', 3)

    expect(candidates).toHaveLength(3)
    expect(new Set(candidates.map((c) => c.name)).size).toBe(3) // no duplicate
    for (const candidate of candidates) {
      expect(candidate.type).toBe('campsite')
      expect(candidate.source).toBe('places')
      expect(candidate.country).toBe('NO')
    }
    const [rvParkCall, campgroundCall] = fetchMock.mock.calls
    expect(JSON.parse(rvParkCall[1].body as string)).toMatchObject({
      includedTypes: ['rv_park'],
    })
    expect(JSON.parse(campgroundCall[1].body as string)).toMatchObject({
      includedTypes: ['campground'],
    })
  })

  // Ranks by quality rather than filtering on it. This is a deliberate change
  // from the lookup that fed only the on-demand picker: these results are now
  // the standing options for a night, and a two-star campsite is still a real
  // place to sleep — offering it below the good one beats offering nothing at
  // all for a stretch of road that has nothing else.
  it('puts a below-par campsite last rather than dropping it', async () => {
    const poor = goodPlace({ rating: 3.0, userRatingCount: 10 })
    const good = goodPlace()
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => jsonResponse({ places: [poor] }))
      .mockImplementationOnce(() => jsonResponse({ places: [good] }))
    vi.stubGlobal('fetch', fetchMock)

    const candidates = await findNearbyCampsites(NEAR, 'NO', 3)

    expect(candidates.map((c) => c.name)).toEqual([
      good.displayName.text,
      poor.displayName.text,
    ])
  })

  it('throws when the Places API key is not configured', async () => {
    vi.unstubAllEnvs()
    await expect(findNearbyCampsites(NEAR, 'NO', 3)).rejects.toThrow(
      /GOOGLE_PLACES_API_KEY/,
    )
  })
})

describe('findNearbyCampsites — ordering', () => {
  // ~0.09 degrees of latitude is roughly 10km; 0.45 is roughly 50km, past
  // OVERNIGHT_CAMPSITE_MAX_KM.
  const at = (dLat: number, overrides: Record<string, unknown> = {}) =>
    goodPlace({
      location: { latitude: NEAR.lat + dLat, longitude: NEAR.lng },
      ...overrides,
    })

  beforeEach(() => {
    placeCounter = 0
    vi.stubEnv('GOOGLE_PLACES_API_KEY', 'test-key')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('returns the closest campsite to the town, not whatever Places ranked first', async () => {
    const near = at(0.02)
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(() => jsonResponse({ places: [at(0.09)] }))
        .mockImplementationOnce(() => jsonResponse({ places: [near] })),
    )

    const found = (await findNearbyCampsites(NEAR, 'NO', 1))[0] ?? null

    expect(found?.name).toBe(near.displayName.text)
  })

  // The whole point is to stop the overnight landing somewhere that isn't
  // the town at all. A site 50km away is a different evening.
  it('ignores a campsite too far from the town to be its overnight', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(() => jsonResponse({ places: [at(0.45)] }))
        .mockImplementationOnce(() => jsonResponse({ places: [] })),
    )

    expect((await findNearbyCampsites(NEAR, 'NO', 1))[0] ?? null).toBeNull()
  })

  // A campsite with four reviews is still somewhere to sleep, and what this
  // is rescuing the plan from is a road junction.
  it('takes an unrated nearby site over nothing at all', async () => {
    const unrated = at(0.02, { rating: undefined, userRatingCount: undefined })
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(() => jsonResponse({ places: [unrated] }))
        .mockImplementationOnce(() => jsonResponse({ places: [] })),
    )

    expect(((await findNearbyCampsites(NEAR, 'NO', 1))[0] ?? null)?.name).toBe(
      unrated.displayName.text,
    )
  })

  it('still prefers a rated site over a marginally closer unrated one', async () => {
    const rated = at(0.05)
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(() =>
          jsonResponse({
            places: [at(0.02, { rating: 2.1, userRatingCount: 3 })],
          }),
        )
        .mockImplementationOnce(() => jsonResponse({ places: [rated] })),
    )

    expect(((await findNearbyCampsites(NEAR, 'NO', 1))[0] ?? null)?.name).toBe(rated.displayName.text)
  })

  it('returns null when there is nothing nearby at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => jsonResponse({ places: [] })),
    )

    expect((await findNearbyCampsites(NEAR, 'NO', 1))[0] ?? null).toBeNull()
  })
})

/**
 * The gate that lets a named sight be trusted as a map pin. Curation now
 * proposes sights rather than towns, and a sight — unlike a town — routinely
 * doesn't exist where it was claimed to, at which point Places answers with
 * whatever famous namesake it does know.
 */
describe('verifyPlaceLocation', () => {
  const TOWN = { lat: 56.03, lng: 12.61 }

  beforeEach(() => {
    vi.stubEnv('GOOGLE_PLACES_API_KEY', 'test-key')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  function place(overrides: Record<string, unknown>) {
    return {
      id: 'p1',
      displayName: { text: 'Kronborg Castle' },
      location: { latitude: 56.038, longitude: 12.621 },
      ...overrides,
    }
  }

  it("accepts a nearby match under Places' own fuller name, and returns that name", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => jsonResponse({ places: [place({})] })),
    )

    await expect(
      verifyPlaceLocation('Kronborg, Helsingør, DK', 'Kronborg', TOWN),
    ).resolves.toMatchObject({ name: 'Kronborg Castle', lat: 56.038 })
  })

  // Precisely the Helsingør-to-Greece shape: the right name, 2,000 km away,
  // because locationBias is a preference and not a bound.
  it('rejects a same-named match that is nowhere near the anchor', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() =>
        jsonResponse({
          places: [place({ location: { latitude: 37.98, longitude: 23.72 } })],
        }),
      ),
    )

    await expect(
      verifyPlaceLocation('Kronborg, Helsingør, DK', 'Kronborg', TOWN),
    ).resolves.toBeNull()
  })

  // The local version of the same failure: something well-known and close by
  // that simply isn't the thing that was asked for.
  it('rejects a nearby place whose name is nothing like the request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() =>
        jsonResponse({
          places: [place({ displayName: { text: 'Bilka Hypermarket' } })],
        }),
      ),
    )

    await expect(
      verifyPlaceLocation('Kronborg, Helsingør, DK', 'Kronborg', TOWN),
    ).resolves.toBeNull()
  })

  // A trailhead or a village church can be exactly right with four reviews.
  it('does not apply the quality bar that activity resolution uses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() =>
        jsonResponse({
          places: [
            place({
              displayName: { text: 'Kronborg Castle' },
              rating: undefined,
              userRatingCount: undefined,
            }),
          ],
        }),
      ),
    )

    await expect(
      verifyPlaceLocation('Kronborg, Helsingør, DK', 'Kronborg', TOWN),
    ).resolves.not.toBeNull()
  })

  it('honours a tighter distance bound than the default', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() =>
        jsonResponse({
          places: [place({ location: { latitude: 56.2, longitude: 12.61 } })],
        }),
      ),
    )

    // ~19 km from the town: inside the default, outside a 5 km bound.
    await expect(
      verifyPlaceLocation('Kronborg, Helsingør, DK', 'Kronborg', TOWN),
    ).resolves.not.toBeNull()
    await expect(
      verifyPlaceLocation('Kronborg, Helsingør, DK', 'Kronborg', TOWN, 5),
    ).resolves.toBeNull()
  })
})
