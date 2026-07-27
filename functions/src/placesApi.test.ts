import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  enrichActivities,
  enrichRestaurantsForMeal,
  type ProposedActivity,
  type ProposedRestaurant,
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

  it('resolves all 5 proposed activities when each meets the quality bar', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => jsonResponse({ places: [goodPlace()] }))
    vi.stubGlobal('fetch', fetchMock)

    const activities = await enrichActivities(proposed, NEAR)

    expect(activities).toHaveLength(5)
    for (const activity of activities) {
      expect(activity.rating).toBeGreaterThanOrEqual(3.8)
      expect(activity.googleMapsUrl).toMatch(/^https:\/\//)
    }
    const uniqueNames = new Set(activities.map((a) => a.name))
    expect(uniqueNames.size).toBe(5)
  })

  it('drops a low-quality match and backfills by category to still return exactly 5', async () => {
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
      // remaining items (2, 3, 4) resolve fine
      .mockImplementation(() => jsonResponse({ places: [goodPlace()] }))
    vi.stubGlobal('fetch', fetchMock)

    const activities = await enrichActivities(proposed, NEAR)

    expect(activities).toHaveLength(5)
    const uniqueNames = new Set(activities.map((a) => a.name))
    expect(uniqueNames.size).toBe(5)
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

  it('resolves exactly 3 restaurants for a meal, each with rating, a maps link, and a photo', async () => {
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

    expect(restaurants).toHaveLength(3)
    for (const restaurant of restaurants) {
      expect(restaurant.rating).toBeGreaterThanOrEqual(3.8)
      expect(restaurant.googleMapsUrl).toMatch(/^https:\/\//)
      // Regression: restaurants used to be built without photoUrl at all
      // (only activities carried it through), so every meal card silently
      // rendered without a photo.
      expect(restaurant.photoUrl).toMatch(/^https:\/\//)
      expect(restaurant.meal).toBe('dinner')
    }
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
