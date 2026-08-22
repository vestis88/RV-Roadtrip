import { describe, expect, it } from 'vitest'
import { MAX_RESCAN_RADIUS_KM, visibleRadiusKm } from './rescanCorridorAction'

describe('visibleRadiusKm', () => {
  // The report this exists for: the visible map ran roughly Båstad to
  // Markaryd, some 80 km across, and the search covered a fixed 25 km circle
  // around the centre. Most of what the traveler was pointing at was never
  // looked at, so "nothing found nearby" was an answer about ground the
  // search never visited.
  it('covers the whole visible rectangle, not a fixed circle', () => {
    const { radiusKm } = visibleRadiusKm({
      north: 56.9,
      south: 56.2,
      east: 13.7,
      west: 12.7,
    })

    // Corner distance, so nothing on screen falls outside it.
    expect(radiusKm).toBeGreaterThan(40)
  })

  /**
   * Briefly floored at 25 km on 2026-08-22 and reverted the same day.
   *
   * A 7 km scan over Plansee returned four finds, all outside the circle,
   * and the floor was the wrong reading of it: "It was right to limit at
   * 7 km. It was wrong to find nothing within the 7 km." Aiming the circle
   * is the traveler's, and a floor overrides the aim. The real fault was
   * that the search was told it was looking at a 1,200 km² district — see
   * reverseGeocode.ts.
   */
  it('shrinks with the viewport, so a close-in scan stays close in', () => {
    const { radiusKm, cappedFrom } = visibleRadiusKm({
      north: 56.55,
      south: 56.45,
      east: 13.1,
      west: 12.95,
    })

    expect(radiusKm).toBeLessThan(10)
    expect(cappedFrom).toBeUndefined()
  })

  // Capping is right — a whole-country viewport is not a searchable area —
  // but it has to be reported, because silently searching less than the
  // traveler is looking at is the original bug.
  it('reports the cap rather than applying it quietly', () => {
    const { radiusKm, cappedFrom } = visibleRadiusKm({
      north: 62,
      south: 55,
      east: 18,
      west: 11,
    })

    expect(radiusKm).toBe(MAX_RESCAN_RADIUS_KM)
    expect(cappedFrom).toBeGreaterThan(MAX_RESCAN_RADIUS_KM)
  })
})

/**
 * The circle is drawn on the map now (see SearchAreaCircle), so the number
 * that draws it and the number that is searched have to be the same one —
 * which is why the screen computes it once and hands it to both.
 */
describe('visibleRadiusKm at the raised cap', () => {
  // The cost basis for the old 50 km cap was web search, which this path no
  // longer uses: one tool-free call returns at most MAX_RESCAN_RESULTS finds
  // whether it is asked about 25 km or 150. A normal regional view now fits.
  it('covers a regional view without capping', () => {
    const { radiusKm, cappedFrom } = visibleRadiusKm({
      north: 57.5,
      south: 56.0,
      east: 25.0,
      west: 23.0,
    })
    expect(cappedFrom).toBeUndefined()
    expect(radiusKm).toBeLessThanOrEqual(MAX_RESCAN_RADIUS_KM)
    expect(radiusKm).toBeGreaterThan(50)
  })

  // And a whole-continent view still caps, still says so, and — now that the
  // circle is drawn — shows exactly how much of the view it covers.
  it('still caps a view far too big to search, and reports it', () => {
    const { radiusKm, cappedFrom } = visibleRadiusKm({
      north: 69,
      south: 45,
      east: 30,
      west: 5,
    })
    expect(radiusKm).toBe(MAX_RESCAN_RADIUS_KM)
    expect(cappedFrom).toBeGreaterThan(MAX_RESCAN_RADIUS_KM)
  })
})
