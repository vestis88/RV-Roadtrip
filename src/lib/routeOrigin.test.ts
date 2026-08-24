import { describe, expect, it } from 'vitest'
import {
  ORIGIN_GRID_DEGREES,
  quantisePosition,
  routeOriginFor,
} from './routeOrigin'

const START = { lat: 48.14, lng: 11.58, name: 'Munich' }
const RUNNING = {
  startPoint: START,
  startDate: '2026-08-20',
  endDate: '2026-09-20',
  today: '2026-08-24',
}

/** Requested 2026-08-24: "routed from our current location." */
describe('where the route starts from', () => {
  it('uses the position while the trip is running', () => {
    const origin = routeOriginFor({
      ...RUNNING,
      position: { lat: 47.55, lng: 10.75 },
    })
    expect(origin.fromPosition).toBe(true)
    expect(origin.point).toMatchObject({ lat: 47.55, lng: 10.75 })
  })

  /**
   * Planning a German trip from a sofa in Sweden would otherwise route it
   * from Sweden, and every number on the board comes off that first leg.
   */
  it('ignores the position before the trip starts', () => {
    const origin = routeOriginFor({
      ...RUNNING,
      today: '2026-08-01',
      position: { lat: 59.33, lng: 18.06 },
    })
    expect(origin.fromPosition).toBe(false)
    expect(origin.point).toBe(START)
  })

  it('ignores the position after the trip ends', () => {
    const origin = routeOriginFor({
      ...RUNNING,
      today: '2026-10-01',
      position: { lat: 47.55, lng: 10.75 },
    })
    expect(origin.fromPosition).toBe(false)
  })

  // Refusing the permission prompt is an answer, not an error: the ordinary
  // planning route is the fallback, silently.
  it('falls back to the start point with no position at all', () => {
    const origin = routeOriginFor({ ...RUNNING, position: null })
    expect(origin.point).toBe(START)
    expect(origin.fromPosition).toBe(false)
  })

})

/**
 * The subtle half. useCurrentPosition WATCHES rather than samples, so it
 * emits a fresh object per fix — and DirectionsRoute lists its points in an
 * effect dependency array, so a new origin per fix is a Directions request
 * per fix. That is the self-sustaining loop that once made this map
 * impossible to pan.
 *
 * Snapping to a grid rather than remembering the last origin, because the
 * remembering version needed a ref written during render, which React
 * forbids. Rounding is pure: the same fix always yields the same cell.
 */
describe('quantising the position', () => {
  it('gives GPS jitter the same cell', () => {
    // ~40 m apart — a twitch, not a journey.
    expect(quantisePosition({ lat: 47.5501, lng: 10.7502 })).toEqual(
      quantisePosition({ lat: 47.5504, lng: 10.7499 }),
    )
  })

  it('gives a real drive a different cell', () => {
    expect(quantisePosition({ lat: 47.55, lng: 10.75 })).not.toEqual(
      quantisePosition({ lat: 47.62, lng: 10.75 }),
    )
  })

  // A cell about a kilometre across: near enough for a decision about which
  // way to drive, small enough not to move the origin somewhere it is not.
  it('stays within about a kilometre of the true position', () => {
    const snapped = quantisePosition({ lat: 47.5567, lng: 10.7543 })
    expect(Math.abs(snapped.lat - 47.5567)).toBeLessThanOrEqual(
      ORIGIN_GRID_DEGREES,
    )
    expect(Math.abs(snapped.lng - 10.7543)).toBeLessThanOrEqual(
      ORIGIN_GRID_DEGREES,
    )
  })
})
