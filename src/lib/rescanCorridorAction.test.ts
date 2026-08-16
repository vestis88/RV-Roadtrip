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
