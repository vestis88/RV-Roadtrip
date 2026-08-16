import { describe, expect, it } from 'vitest'
import { emptyPreferredCountries } from './countryCoverage.js'
import type { RegionHighlightsResponse } from './prompts/planTripSchema.js'

function region(
  country: string,
  stops: { lat?: number; lng?: number }[],
  reasoning = '',
): RegionHighlightsResponse['regions'][number] {
  return {
    region: `${country} region`,
    country,
    reasoning,
    candidateStops: stops.map((stop, i) => ({
      sight: `${country} sight ${i}`,
      town: `${country} town`,
      country,
      why: 'Because.',
      priority: 'worth-a-detour' as const,
      ...stop,
    })),
  }
}

/**
 * "Why is it dropping Estonia without a message even though it is added as a
 * country to visit?" — the answer was that preferredCountries was read by no
 * code anywhere, so nothing could have produced a message.
 */
describe('emptyPreferredCountries', () => {
  it('says nothing about a country that produced located candidates', () => {
    const highlights = {
      regions: [region('SE', [{ lat: 59, lng: 18 }])],
    }
    expect(emptyPreferredCountries(['SE'], highlights)).toEqual([])
  })

  // The case that was reported: a chosen country simply absent from the
  // answer. Indistinguishable, from the map, from one that was never chosen.
  it('reports a chosen country curation never mentioned', () => {
    const highlights = { regions: [region('SE', [{ lat: 59, lng: 18 }])] }

    expect(emptyPreferredCountries(['SE', 'EE'], highlights)).toEqual([
      { country: 'EE', reason: 'not-proposed', proposed: 0 },
    ])
  })

  // Different problem, different fix: these were proposed and then lost to
  // map lookups. Counting them apart is the entire point.
  it('separates "nothing proposed" from "nothing could be located"', () => {
    const highlights = {
      regions: [region('EE', [{}, {}])],
    }

    expect(emptyPreferredCountries(['EE'], highlights)).toEqual([
      { country: 'EE', reason: 'not-located', proposed: 2 },
    ])
  })

  // Curation is now told to return an empty region WITH its reasoning rather
  // than omitting the country, so that explanation is the best one available.
  it("passes through curation's own explanation when it gave one", () => {
    const highlights = {
      regions: [
        region('EE', [], 'Nothing here answers downhill mountain biking.'),
      ],
    }

    expect(emptyPreferredCountries(['EE'], highlights)).toEqual([
      {
        country: 'EE',
        reason: 'not-proposed',
        proposed: 0,
        note: 'Nothing here answers downhill mountain biking.',
      },
    ])
  })

  it('counts a country as covered if any one region in it has a located sight', () => {
    const highlights = {
      regions: [region('EE', [{}]), region('EE', [{ lat: 59, lng: 24 }])],
    }
    expect(emptyPreferredCountries(['EE'], highlights)).toEqual([])
  })

  it('matches country codes regardless of case', () => {
    const highlights = { regions: [region('ee', [{ lat: 59, lng: 24 }])] }
    expect(emptyPreferredCountries(['EE'], highlights)).toEqual([])
  })

  it('has nothing to report when no countries were chosen', () => {
    const highlights = { regions: [region('SE', [])] }
    expect(emptyPreferredCountries([], highlights)).toEqual([])
  })
})
