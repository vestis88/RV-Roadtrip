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
  // The reported bug: "Hitta en mysig restaurang i Hillerød" spent four
  // minutes in Claude and then failed the client timeout, while Google Maps
  // showed a dozen well-rated restaurants in that same town.
  it('answers a findable-place query from Places, without calling Claude at all', async () => {
    searchPlacesByQueryMock.mockResolvedValue([place()])
    const { findStopsForQuery } = await import('./querySearch.js')

    const result = await findStopsForQuery({
      query: 'a cozy restaurant in Hillerød',
      center: HILLEROD,
      radiusKm: 25,
    })

    expect(result.source).toBe('places')
    expect(result.finds).toHaveLength(1)
    expect(result.finds[0]).toMatchObject({
      name: 'Restaurant Krydderiet',
      country: 'DK',
      lat: 55.93,
    })
    expect(generateRescanCandidatesMock).not.toHaveBeenCalled()
  })

  it('says what it actually knows in the "why", rather than inventing prose', async () => {
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

  it('falls back to Claude when Places finds nothing', async () => {
    searchPlacesByQueryMock.mockResolvedValue([])
    generateRescanCandidatesMock.mockResolvedValue([
      { name: 'A viewpoint', country: 'DK', why: 'Great view.', ...HILLEROD },
    ])
    const { findStopsForQuery } = await import('./querySearch.js')

    const result = await findStopsForQuery({
      query: 'somewhere with a nice view about halfway',
      center: HILLEROD,
      radiusKm: 25,
    })

    expect(result.source).toBe('claude')
    expect(result.finds).toHaveLength(1)
  })

  // A Places outage must not take the whole search down — the slower path
  // still works.
  it('falls back to Claude when Places itself fails', async () => {
    searchPlacesByQueryMock.mockRejectedValue(new Error('quota exceeded'))
    generateRescanCandidatesMock.mockResolvedValue([
      { name: 'A viewpoint', country: 'DK', why: 'Great view.', ...HILLEROD },
    ])
    const { findStopsForQuery } = await import('./querySearch.js')

    const result = await findStopsForQuery({
      query: 'a cozy restaurant in Hillerød',
      center: HILLEROD,
      radiusKm: 25,
    })
    expect(result.source).toBe('claude')
  })

  it('drops Places hits outside the search radius, and asks Claude if that leaves none', async () => {
    searchPlacesByQueryMock.mockResolvedValue([
      // Roughly 400km away — Places biases, it doesn't restrict.
      place({ name: 'Faraway Grill', lat: 59.3, lng: 18.1, country: 'SE' }),
    ])
    const { findStopsForQuery } = await import('./querySearch.js')

    const result = await findStopsForQuery({
      query: 'a cozy restaurant in Hillerød',
      center: HILLEROD,
      radiusKm: 25,
    })

    expect(result.source).toBe('claude')
    expect(generateRescanCandidatesMock).toHaveBeenCalled()
  })

  it('caps how many pins one query can drop on the map', async () => {
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
