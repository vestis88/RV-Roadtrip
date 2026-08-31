import { describe, expect, it } from 'vitest'
import { livePacingWarnings } from './livePacingWarnings'

/**
 * Reported 2026-08-31: "This list on top seems completely obsolete!" — five
 * warnings about days in Germany and Switzerland, read from a campsite in
 * the Dolomites eleven days later.
 */
describe('livePacingWarnings', () => {
  const past =
    'Day 1 (2026-08-20) drives 581 km and is also the day for Rothenburg ob der Tauber, a half-day sight.'
  const ahead =
    'Day 20 (2026-09-08) drives 264 km and is also the day for il Mercato Centrale Firenze.'
  const undated =
    'The second half of the trip carries most of the driving — 62% of it after day 10.'

  it('drops advice about a day already driven', () => {
    expect(livePacingWarnings([past, ahead], '2026-08-31')).toEqual([ahead])
  })

  /**
   * Pacing advice is about a decision — "either the drive moves to another
   * day or the sight does" — and after the day happens the same sentence is
   * asking the traveler to rearrange the past.
   */
  it('keeps today, which is still a day you can rearrange', () => {
    const todayWarning = 'Day 12 (2026-08-31) drives 400 km.'
    expect(livePacingWarnings([todayWarning], '2026-08-31')).toEqual([
      todayWarning,
    ])
  })

  // The whole-trip warnings never went stale, and guessing at a sentence we
  // cannot read would throw away the useful ones to be tidy.
  it('keeps a warning that names no day', () => {
    expect(livePacingWarnings([undated], '2026-12-01')).toEqual([undated])
  })

  it('is empty rather than undefined when there is nothing to say', () => {
    expect(livePacingWarnings(undefined, '2026-08-31')).toEqual([])
    expect(livePacingWarnings([past], '2026-08-31')).toEqual([])
  })
})
