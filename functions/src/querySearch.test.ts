import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { QueryPlaceFind } from './placesApi.js'

const searchPlacesByQueryMock = vi.fn()
vi.mock('./placesApi.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./placesApi.js')>()
  return {
    ...actual,
    searchPlacesByQuery: (...args: unknown[]) => searchPlacesByQueryMock(...args),
  }
})

const generateRescanCandidatesMock = vi.fn()
vi.mock('./prompts/rescanCorridor.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./prompts/rescanCorridor.js')>()
  return {
    ...actual,
    generateRescanCandidates: (...args: unknown[]) =>
      generateRescanCandidatesMock(...args),
  }
})

const HILLEROD = { lat: 55.93, lng: 12.31 }

function place(overrides: Partial<QueryPlaceFind> = {}): QueryPlaceFind {
  return {
    name: 'Restaurant Krydderiet',
    lat: 55.93,
    lng: 12.3,
    country: 'DK',
    rating: 4.4,
    ratingCount: 312,
    ...overrides,
  }
}

beforeEach(() => {
  searchPlacesByQueryMock.mockReset().mockResolvedValue([])
  generateRescanCandidatesMock.mockReset().mockResolvedValue([])
})

describe('findStopsForQuery', () => {
  /**
   * Inverted 2026-08-24: "the good descriptions and pictures were dropped…
   * I'd also like the std Claude search to be default also for zoomed in,
   * and places if nothing is found."
   *
   * Both of those are structural rather than incidental. The Places branch
   * describes a find with a template — its Google summary, its star rating,
   * "Matched your search" — which is the generic-blurb complaint from
   * 2026-08-18; and it never sets `photoUrl` at all, so pictures were not
   * lost down this path, they were never reachable.
   */
  it('answers from Claude by default, without touching Places', async () => {
    searchPlacesByQueryMock.mockResolvedValue([place()])
    generateRescanCandidatesMock.mockResolvedValue([
      {
        name: 'Seiser Alm',
        country: 'IT',
        why: "Europe's largest high-alpine meadow, with gentle gravel routes.",
        photoUrl: 'https://example.test/photo.jpg',
        ...HILLEROD,
      },
    ])
    const { findStopsForQuery } = await import('./querySearch.js')

    const result = await findStopsForQuery({
      query: 'something worth doing nearby right now',
      center: HILLEROD,
      radiusKm: 25,
    })

    expect(result.source).toBe('claude')
    // The two things the report was about, both of which only this path has.
    expect(result.finds[0].why).toContain('high-alpine meadow')
    expect(result.finds[0].photoUrl).toBeTruthy()
    expect(searchPlacesByQueryMock).not.toHaveBeenCalled()
  })

  it('falls back to Places when Claude has nothing to say', async () => {
    generateRescanCandidatesMock.mockResolvedValue([])
    searchPlacesByQueryMock.mockResolvedValue([place()])
    const { findStopsForQuery } = await import('./querySearch.js')

    const result = await findStopsForQuery({
      query: 'Lidl in Hillerød',
      center: HILLEROD,
      radiusKm: 25,
    })

    expect(result.source).toBe('places')
    expect(result.finds[0]).toMatchObject({
      name: 'Restaurant Krydderiet',
      country: 'DK',
      lat: 55.93,
    })
  })

  /**
   * A Claude outage — no key, a timeout, a bad turn — must not take the
   * whole search down. That is the entire reason the Places path is kept
   * rather than deleted.
   */
  it('falls back to Places when Claude fails outright', async () => {
    generateRescanCandidatesMock.mockRejectedValue(new Error('no api key'))
    searchPlacesByQueryMock.mockResolvedValue([place()])
    const { findStopsForQuery } = await import('./querySearch.js')

    const result = await findStopsForQuery({
      query: 'a cozy restaurant in Hillerød',
      center: HILLEROD,
      radiusKm: 25,
    })
    expect(result.source).toBe('places')
    expect(result.finds).toHaveLength(1)
  })

  /**
   * A search that BROKE must never read as a search that found nothing.
   *
   * This test first asserted the opposite — that two failures returned an
   * empty list — and an existing e2e test caught it immediately: the
   * credential-less sandbox stopped showing its error banner and started
   * telling the traveler to widen a search that had never run.
   */
  it('fails loudly when both engines are broken', async () => {
    generateRescanCandidatesMock.mockRejectedValue(new Error('no api key'))
    searchPlacesByQueryMock.mockRejectedValue(new Error('quota exceeded'))
    const { findStopsForQuery } = await import('./querySearch.js')

    await expect(
      findStopsForQuery({ query: 'anything', center: HILLEROD, radiusKm: 25 }),
    ).rejects.toThrow(/Both searches failed/)
  })

  // Claude answering "nothing here" is a real answer, so a broken Places
  // behind it is not worth failing over.
  it('accepts an empty answer from a Claude turn that worked', async () => {
    generateRescanCandidatesMock.mockResolvedValue([])
    searchPlacesByQueryMock.mockRejectedValue(new Error('quota exceeded'))
    const { findStopsForQuery } = await import('./querySearch.js')

    const result = await findStopsForQuery({
      query: 'anything',
      center: HILLEROD,
      radiusKm: 25,
    })
    expect(result.finds).toEqual([])
  })

  // The fallback's own blurb, which is the best it can honestly do — and
  // exactly why it is the fallback.
  it('says what it actually knows in the "why", rather than inventing prose', async () => {
    generateRescanCandidatesMock.mockResolvedValue([])
    searchPlacesByQueryMock.mockResolvedValue([place()])
    const { findStopsForQuery } = await import('./querySearch.js')

    const { finds } = await findStopsForQuery({
      query: 'a cozy restaurant in Hillerød',
      center: HILLEROD,
      radiusKm: 25,
    })

    expect(finds[0].why).toContain('4.4/5')
    expect(finds[0].why).toContain('312')
    expect(finds[0].why).toContain('a cozy restaurant in Hillerød')
  })

  it('prefers Google’s own summary when it has one', async () => {
    generateRescanCandidatesMock.mockResolvedValue([])
    searchPlacesByQueryMock.mockResolvedValue([
      place({ summary: 'Nordic small plates in a candlelit cellar.' }),
    ])
    const { findStopsForQuery } = await import('./querySearch.js')

    const { finds } = await findStopsForQuery({
      query: 'cozy restaurant',
      center: HILLEROD,
      radiusKm: 25,
    })
    expect(finds[0].why).toContain('candlelit cellar')
  })

  // The corridor filter still applies to the fallback: Places biases toward
  // a point, it does not restrict to one, so a hit 400 km away comes back
  // looking just like a local one.
  it('still drops fallback hits outside the search radius', async () => {
    generateRescanCandidatesMock.mockResolvedValue([])
    searchPlacesByQueryMock.mockResolvedValue([
      place({ name: 'Faraway Grill', lat: 59.3, lng: 18.1, country: 'SE' }),
    ])
    const { findStopsForQuery } = await import('./querySearch.js')

    const result = await findStopsForQuery({
      query: 'a cozy restaurant in Hillerød',
      center: HILLEROD,
      radiusKm: 25,
    })

    expect(result.finds).toEqual([])
  })

  it('caps how many pins one query can drop on the map', async () => {
    generateRescanCandidatesMock.mockResolvedValue([])
    searchPlacesByQueryMock.mockResolvedValue(
      Array.from({ length: 20 }, (_, i) => place({ name: `Place ${i}` })),
    )
    const { findStopsForQuery } = await import('./querySearch.js')

    const { finds } = await findStopsForQuery({
      query: 'restaurant',
      center: HILLEROD,
      radiusKm: 25,
    })
    expect(finds.length).toBeLessThanOrEqual(8)
  })
})
