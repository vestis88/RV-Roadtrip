import { describe, expect, it } from 'vitest'
import { describeGooglePlace } from './googlePlaceDetails'

/**
 * Requested 2026-08-31: "add its photo and brief description as well. Do not
 * overwrite our own description!"
 */
describe('describeGooglePlace', () => {
  it('leads with Google’s own blurb and backs it with the rating', () => {
    expect(
      describeGooglePlace({
        summary: 'Medieval castle with battlements, a tower and a drawbridge.',
        rating: 4.7,
        ratingCount: 19750,
      }),
    ).toBe(
      'Medieval castle with battlements, a tower and a drawbridge. Rated 4.7/5 from 19750 Google reviews.',
    )
  })

  // Most places have no editorial summary at all, which is exactly why the
  // rating is worth stating rather than inventing prose.
  it('says what it knows when there is no blurb', () => {
    expect(describeGooglePlace({ rating: 4.4, ratingCount: 312 })).toBe(
      'Rated 4.4/5 from 312 Google reviews.',
    )
  })

  /**
   * Undefined, not an empty string: the caller writes this into `why` only
   * when the traveler left the field blank, and a blank sentence there is
   * worse than no field — the card would render an empty paragraph where a
   * reason should be.
   */
  it('says nothing rather than something empty', () => {
    expect(describeGooglePlace({})).toBeUndefined()
    expect(describeGooglePlace(null)).toBeUndefined()
    expect(describeGooglePlace(undefined)).toBeUndefined()
  })

  // A rating with no count, or a count with no rating, is half a fact.
  it('does not report half a rating', () => {
    expect(describeGooglePlace({ rating: 4.4 })).toBeUndefined()
    expect(describeGooglePlace({ ratingCount: 312 })).toBeUndefined()
  })
})

/** The emphasis in the request, tested by name: "Do not overwrite our own
 * description!" */
describe('stopDescription', () => {
  const google = { summary: 'A medieval castle.', rating: 4.7, ratingCount: 19750 }

  it('keeps what the traveler wrote, whatever Google says', async () => {
    const { stopDescription } = await import('./googlePlaceDetails')
    expect(stopDescription('Where we broke down in 2019', google)).toBe(
      'Where we broke down in 2019',
    )
  })

  it('falls back to Google only for a field left empty', async () => {
    const { stopDescription } = await import('./googlePlaceDetails')
    expect(stopDescription('   ', google)).toBe(
      'A medieval castle. Rated 4.7/5 from 19750 Google reviews.',
    )
  })

  it('leaves the field absent when neither has anything to say', async () => {
    const { stopDescription } = await import('./googlePlaceDetails')
    expect(stopDescription('', null)).toBeUndefined()
  })
})
