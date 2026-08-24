import { describe, expect, it } from 'vitest'
import {
  applyRouteOrder,
  isNewRouteOrder,
  manualRouteOrder,
  mayOptimize,
} from './routeOrder'

const STOPS = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
const KEY = 'a,b,c'

/**
 * Requested 2026-08-23: "Google should still optimize the route by default,
 * but there should be some manual override possible, that can then also be
 * reset."
 */
describe('a hand-made route order', () => {
  it('lets Google optimise until the traveler arranges it', () => {
    expect(mayOptimize(null)).toBe(true)
    expect(mayOptimize({ key: KEY, order: [1, 0, 2] })).toBe(true)
    expect(mayOptimize(manualRouteOrder(KEY, [1, 0, 2]))).toBe(false)
  })

  it('applies exactly like an optimised one', () => {
    const applied = applyRouteOrder(STOPS, manualRouteOrder(KEY, [2, 0, 1]), KEY)
    expect(applied.map((s) => s.id)).toEqual(['c', 'a', 'b'])
  })

  /**
   * The failure this flag exists to prevent, and it would have been subtle:
   * the two orders are indistinguishable once stored — both are just lists
   * of positions — so without recording WHO made it, the next Directions
   * reply overwrites the traveler's arrangement and the override appears to
   * work only until the map refreshes.
   */
  it('is still reported as new, so the board must refuse it explicitly', () => {
    const held = manualRouteOrder(KEY, [2, 0, 1])
    expect(isNewRouteOrder(held, KEY, [0, 1, 2])).toBe(true)
  })

  // Resetting is dropping it, after which Google is back in charge.
  it('goes back to Google when cleared', () => {
    expect(mayOptimize(null)).toBe(true)
    expect(applyRouteOrder(STOPS, null, KEY).map((s) => s.id)).toEqual([
      'a',
      'b',
      'c',
    ])
  })

  // A stale order for a different set of stops is ignored, manual or not.
  it('is ignored once the kept stops change', () => {
    const applied = applyRouteOrder(STOPS, manualRouteOrder('a,b', [1, 0]), KEY)
    expect(applied.map((s) => s.id)).toEqual(['a', 'b', 'c'])
  })
})
