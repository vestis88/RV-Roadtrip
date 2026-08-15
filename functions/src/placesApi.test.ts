import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  backfillActivities,
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

/** A place with a name of its own, for the by-name resolution paths. */
function namedPlace(name: string, overrides: Record<string, unknown> = {}) {
  return goodPlace({ displayName: { text: name }, ...overrides })
}

function jsonResponse(body: unknown) {
  return Promise.resolve({
    ok: true,
    json: async () => body,
  })
}

interface SearchRequest {
  url: string
  textQuery?: string
  includedTypes?: string[]
}

function requestOf(call: [string, { body: string }]): SearchRequest {
  const body = JSON.parse(call[1].body) as {
    textQuery?: string
    includedTypes?: string[]
  }
  return { url: String(call[0]), ...body }
}

/**
 * A Places stub that finds exactly what it is asked for: a text search for
 * "Some Café, Vejle" answers with a place called "Some Café". Anything else
 * (a bare category query, a nearby search) answers with a generic well-rated
 * place. This is the happy path — proposals that Places can verify.
 */
function fetchFindingEverything() {
  return vi.fn().mockImplementation((url: string, init: { body: string }) => {
    const request = requestOf([url, init])
    if (request.url.includes('searchText') && request.textQuery?.includes(',')) {
      return jsonResponse({ places: [namedPlace(request.textQuery.split(',')[0])] })
    }
    return jsonResponse({ places: [goodPlace()] })
  })
}

/**
 * A Places stub whose category searches (text or nearby) answer with a fixed
 * pool, and whose by-name searches find nothing usable — the failure this
 * whole area exists for.
 */
function fetchFillingFrom(pool: ReturnType<typeof goodPlace>[]) {
  return vi.fn().mockImplementation((url: string, init: { body: string }) => {
    const request = requestOf([url, init])
    const isNamedLookup =
      request.url.includes('searchText') && (request.textQuery?.includes(',') ?? false)
    return jsonResponse({ places: isNamedLookup ? [] : pool })
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
    vi.stubGlobal('fetch', fetchFindingEverything())

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
    // Every displayed one is the place that was actually proposed, keeps the
    // proposal's own words, and is not labelled a substitute.
    expect(activities.slice(0, 5).map((a) => a.name)).toEqual(
      proposed.map((p) => p.name),
    )
    expect(activities.slice(0, 5).every((a) => a.blurb === 'A nice spot.')).toBe(true)
    expect(activities.slice(0, 5).every((a) => !a.substitute)).toBe(true)
  })

  it('drops a low-quality match and backfills by category to still return exactly 5 displayed + 2 reserve', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation((url: string, init: { body: string }) => {
        const request = requestOf([url, init])
        const named = request.url.includes('searchText') && request.textQuery?.includes(',')
        if (!named) return jsonResponse({ places: [goodPlace()] })
        const name = request.textQuery!.split(',')[0]
        return jsonResponse({
          places: [
            name === 'Attraction 1'
              ? namedPlace(name, { rating: 3.0, userRatingCount: 10 })
              : namedPlace(name),
          ],
        })
      })
    vi.stubGlobal('fetch', fetchMock)

    const activities = await enrichActivities(proposed, NEAR)

    expect(activities).toHaveLength(7)
    const uniqueNames = new Set(activities.map((a) => a.name))
    expect(uniqueNames.size).toBe(7)
    expect(activities.filter((a) => a.reserve).length).toBe(2)
    // The dud is gone, and what took its slot says so rather than borrowing
    // "A nice spot." from the proposal it replaced.
    expect(activities.map((a) => a.name)).not.toContain('Attraction 1')
    const stand_in = activities.find((a) => a.substitute)!
    expect(stand_in.blurb).not.toBe('A nice spot.')
    expect(stand_in.blurb).toMatch(/well-rated/)
  })

  /**
   * The reported failure, in its activity form: the by-name lookup finds
   * nothing (or nothing that IS the named place), and the slot is filled from
   * a category search. Everything about the filler must say filler — the
   * blurb above all, since that is the sentence the traveler reads.
   */
  it('never lets a filler inherit the proposal it replaced', async () => {
    vi.stubGlobal('fetch', fetchFillingFrom([goodPlace(), goodPlace(), goodPlace()]))

    const activities = await enrichActivities(
      [
        {
          name: 'Kunstmuseet i Lillehammer',
          town: 'Lillehammer',
          category: 'museum',
          kidFriendly: true,
          blurb: 'Norwegian art in a Snøhetta-designed building.',
        },
      ],
      NEAR,
    )

    expect(activities.length).toBeGreaterThan(0)
    for (const activity of activities) {
      expect(activity.substitute).toBe(true)
      expect(activity.blurb).not.toContain('Snøhetta')
      expect(activity.blurb).toMatch(/^A well-rated local /)
    }
  })

  it('throws when the Places API key is not configured', async () => {
    vi.unstubAllEnvs()
    await expect(enrichActivities(proposed, NEAR)).rejects.toThrow(
      /GOOGLE_PLACES_API_KEY/,
    )
  })

  // Regression test for a real production 400: the Places API (New) rejects
  // 'point_of_interest' as an includedTypes value for searchNearby (it's a
  // Text-Search-only generic type). The 'other' category must omit
  // includedTypes entirely rather than send it. Driven through
  // backfillActivities with enough slots to rotate all the way to 'other',
  // which is the only caller that can reach that category.
  it('omits includedTypes from the nearby search for the "other" category', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => jsonResponse({ places: [goodPlace()] }))
    vi.stubGlobal('fetch', fetchMock)

    // One slot per category, so the rotation has to reach 'other' — which is
    // last. Keep this at the number of categories in ACTIVITY_PLACE_TYPE.
    await backfillActivities(NEAR, new Set<string>(), 'test-key', 7, false)

    const nearbyRequests = fetchMock.mock.calls
      .map((call) => requestOf(call as [string, { body: string }]))
      .filter((request) => request.url.includes('searchNearby'))
    expect(nearbyRequests.length).toBeGreaterThanOrEqual(7)
    expect(
      nearbyRequests.filter((request) => request.includedTypes === undefined),
    ).toHaveLength(1)
    expect(
      nearbyRequests.some((request) =>
        request.includedTypes?.includes('point_of_interest'),
      ),
    ).toBe(false)
  })

  // The 'point_of_interest' 400 above was found in production, by a day that
  // came back with no activities at all — one wrong type in the category
  // table took the whole backfill down with it. Types are added to that
  // table by hand (see ACTIVITY_PLACE_TYPE) and cannot be checked from the
  // development sandbox, so the next wrong one is a question of when. It
  // should cost that category its nearby results and nothing else: the text
  // search asks the same question in words and still answers.
  it('degrades one rejected category to text search instead of failing the day', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('searchNearby')) {
        return Promise.resolve({
          ok: false,
          status: 400,
          text: async () => 'Invalid includedTypes',
          json: async () => ({}),
        })
      }
      return jsonResponse({ places: [goodPlace()] })
    })
    vi.stubGlobal('fetch', fetchMock)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const filled = await backfillActivities(
      NEAR,
      new Set<string>(),
      'test-key',
      3,
      false,
    )

    expect(filled).toHaveLength(3)
    // Loudly, so a bad mapping is greppable rather than a quiet shortfall.
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })

  // Anything that isn't our own malformed request is a fact about the key,
  // not about one category — swallowing it is how an outage turns into "the
  // app just stopped suggesting things".
  it('still fails loudly when the whole key is rejected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() =>
        Promise.resolve({
          ok: false,
          status: 403,
          text: async () => 'PERMISSION_DENIED',
          json: async () => ({}),
        }),
      ),
    )

    await expect(
      backfillActivities(NEAR, new Set<string>(), 'test-key', 3, false),
    ).rejects.toThrow(/403/)
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
    vi.stubGlobal('fetch', fetchFindingEverything())

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
    expect(restaurants.slice(0, 3).every((r) => r.blurb === 'Good food.')).toBe(true)
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

  /**
   * The BIG Shopping case, end to end. A lunch stop was proposed as a named
   * café; Places could not find it; the slot was filled by a category search
   * that returned a shopping centre — 3.8 stars, 9,125 reviews, the most
   * prominent thing in town — and the centre was written out still carrying
   * the café's description.
   *
   * Three separate things must hold now: the mall loses to the better-rated
   * kitchen, the café's words never travel to anything that isn't the café,
   * and the card that does get shown admits it is a substitute.
   */
  it('does not serve a prominent shopping centre as lunch, and never with the café’s blurb', async () => {
    const mall = namedPlace('BIG Shopping', { rating: 3.8, userRatingCount: 9125 })
    const kitchen = namedPlace('Munkebo Køkken', { rating: 4.6, userRatingCount: 320 })
    const bakery = namedPlace('Bageriet', { rating: 4.4, userRatingCount: 150 })
    vi.stubGlobal('fetch', fetchFillingFrom([mall, kitchen, bakery]))

    const restaurants = await enrichRestaurantsForMeal(
      [
        {
          name: 'Café Sletten',
          town: 'Vejle',
          meal: 'lunch',
          blurb: 'Charming lakeside café near the castle.',
        },
      ],
      'lunch',
      NEAR,
      new Set<string>(),
    )

    expect(restaurants.map((r) => r.name)).not.toContain('BIG Shopping')
    expect(restaurants[0].name).toBe('Munkebo Køkken')
    for (const restaurant of restaurants) {
      expect(restaurant.blurb).not.toContain('lakeside')
      expect(restaurant.blurb).toBe('A well-rated spot for lunch.')
      expect(restaurant.substitute).toBe(true)
    }
  })

  /**
   * "I want top rated alternatives!" — the fill is a ranking problem, and
   * both naive answers are wrong: taking whatever Places listed first gives
   * the mall (prominence is popularity), and sorting on rating alone gives
   * the 5.0 that three friends and the owner left.
   */
  it('fills with the best-rated place that has enough reviews to mean it', async () => {
    const prominent = namedPlace('Storcenter Grill', {
      rating: 4.1,
      userRatingCount: 9125,
    })
    const excellent = namedPlace('Spisehuset', { rating: 4.6, userRatingCount: 300 })
    const noise = namedPlace('Nyt Sted', { rating: 5.0, userRatingCount: 6 })
    vi.stubGlobal('fetch', fetchFillingFrom([prominent, excellent, noise]))

    const restaurants = await enrichRestaurantsForMeal(
      [],
      'dinner',
      NEAR,
      new Set<string>(),
    )

    expect(restaurants[0].name).toBe('Spisehuset')
    expect(restaurants.map((r) => r.name)).not.toContain('Nyt Sted')
  })

  /**
   * The degradation the ladder exists for. Nothing here clears "4.3 with 100
   * reviews", so the rungs relax — and once they do, the well-liked place
   * with 12 reviews beats the merely-okay one with 40. A stretch of road
   * with two restaurants should offer them, not offer nothing.
   */
  it('relaxes the review-count requirement rather than leaving a meal empty', async () => {
    const okay = namedPlace('Vejkroen', { rating: 4.05, userRatingCount: 40 })
    const loved = namedPlace('Fjordhytten', { rating: 4.2, userRatingCount: 12 })
    vi.stubGlobal('fetch', fetchFillingFrom([okay, loved]))

    const restaurants = await enrichRestaurantsForMeal(
      [],
      'dinner',
      NEAR,
      new Set<string>(),
    )

    expect(restaurants.map((r) => r.name)).toEqual(['Fjordhytten', 'Vejkroen'])
  })

  /**
   * There is still a bottom to the ladder. A restaurant below
   * MIN_RESTAURANT_RATING is not offered at all — filling the row is not
   * worth answering "where should we eat?" with somewhere the reviews say
   * not to.
   */
  it('leaves the meal short rather than offering a badly-rated restaurant', async () => {
    vi.stubGlobal(
      'fetch',
      fetchFillingFrom([
        namedPlace('Grillbaren', { rating: 3.4, userRatingCount: 400 }),
        namedPlace('Pølsevognen', { rating: 3.9, userRatingCount: 80 }),
      ]),
    )

    const restaurants = await enrichRestaurantsForMeal(
      [],
      'dinner',
      NEAR,
      new Set<string>(),
    )

    expect(restaurants).toEqual([])
  })

  /**
   * Restaurants are held to a higher floor than sights — see
   * MIN_RESTAURANT_RATING. A 3.9 restaurant Claude named is dropped and its
   * slot refilled; a 3.9 museum is kept, because a 3.9 museum is fine.
   */
  it('drops a named restaurant below the restaurant floor that a sight would clear', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation((url: string, init: { body: string }) => {
        const request = requestOf([url, init])
        if (request.url.includes('searchText') && request.textQuery?.includes(',')) {
          return jsonResponse({
            places: [
              namedPlace(request.textQuery.split(',')[0], {
                rating: 3.9,
                userRatingCount: 500,
              }),
            ],
          })
        }
        return jsonResponse({ places: [] })
      })
    vi.stubGlobal('fetch', fetchMock)

    const restaurants = await enrichRestaurantsForMeal(
      [{ name: 'Slagterens Bord', town: 'Vejle', meal: 'dinner', blurb: 'Meat.' }],
      'dinner',
      NEAR,
      new Set<string>(),
    )
    const activities = await enrichActivities(
      [
        {
          name: 'Byens Museum',
          town: 'Vejle',
          category: 'museum',
          kidFriendly: false,
          blurb: 'Local history.',
        },
      ],
      NEAR,
    )

    expect(restaurants).toEqual([])
    expect(activities.map((a) => a.name)).toContain('Byens Museum')
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

  // The reason this routes through bestCandidate rather than taking Places'
  // first passing result: Places orders by prominence, and a busy bakery
  // named after the castle is more prominent than the castle. Both clear the
  // name gate, so without nameMatchScore ordering the sight loses to its own
  // namesake — and with no quality bar here, ratings must not rescue it
  // either.
  it('prefers the sight itself over a better-known near-namesake listed first', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() =>
        jsonResponse({
          places: [
            place({
              id: 'bakery',
              displayName: { text: 'Kronborg Bageri og Konditori' },
              rating: 4.8,
              userRatingCount: 2400,
            }),
            place({
              id: 'castle',
              displayName: { text: 'Kronborg Castle' },
              rating: 4.5,
              userRatingCount: 900,
            }),
          ],
        }),
      ),
    )

    await expect(
      verifyPlaceLocation('Kronborg, Helsingør, DK', 'Kronborg', TOWN),
    ).resolves.toMatchObject({ name: 'Kronborg Castle' })
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
