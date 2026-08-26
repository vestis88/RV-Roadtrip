import { describe, expect, it } from 'vitest'
import {
  applyRouteOrder,
  isNewRouteOrder,
  manualRouteOrder,
  mayOptimize,
  routeOrderKey,
} from './routeOrder'

const stops = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
const key = routeOrderKey(stops)

/**
 * These exist because the route visibly thrashed on a phone: the lines moved,
 * and the driving time never resolved. DirectionsRoute lists its points in an
 * effect dependency array, so feeding Google's answer back in as the next
 * request's input closed a circuit — every reply produced a fresh array,
 * which re-fired the request, which cancelled the one in flight.
 */
describe('applyRouteOrder', () => {
  // The one that matters. Once the order is right Google keeps agreeing with
  // it, so the identity permutation is the steady state — and it must not
  // allocate, or every reply produces a new array and asks again.
  it('returns the very same array when the order changes nothing', () => {
    expect(applyRouteOrder(stops, { key, order: [0, 1, 2] }, key)).toBe(stops)
  })

  it('reorders when the order actually says something', () => {
    expect(
      applyRouteOrder(stops, { key, order: [2, 0, 1] }, key).map((s) => s.id),
    ).toEqual(['c', 'a', 'b'])
  })

  it('ignores an order computed for a different set of stops', () => {
    expect(applyRouteOrder(stops, { key: 'a,b', order: [1, 0] }, key)).toBe(stops)
  })

  it('ignores an order of the wrong length', () => {
    expect(applyRouteOrder(stops, { key, order: [1, 0] }, key)).toBe(stops)
  })

  it('ignores an order pointing at positions that do not exist', () => {
    expect(applyRouteOrder(stops, { key, order: [0, 1, 9] }, key)).toBe(stops)
  })

  it('has nothing to apply before Google has answered', () => {
    expect(applyRouteOrder(stops, null, key)).toBe(stops)
  })
})

describe('isNewRouteOrder', () => {
  // Storing an order identical to the one held would re-render, rebuild the
  // arrays and ask Google the same question again.
  it('is false when the held order already says this', () => {
    expect(isNewRouteOrder({ key, order: [2, 0, 1] }, key, [2, 0, 1])).toBe(false)
  })

  it('is true when the order genuinely changed', () => {
    expect(isNewRouteOrder({ key, order: [0, 1, 2] }, key, [2, 0, 1])).toBe(true)
  })

  it('is true when the stops it describes changed', () => {
    expect(isNewRouteOrder({ key: 'a,b', order: [0, 1] }, key, [0, 1])).toBe(true)
  })

  it('is true when nothing is held yet', () => {
    expect(isNewRouteOrder(null, key, [0, 1, 2])).toBe(true)
  })
})

describe('routeOrderKey', () => {
  it('changes when the set of stops changes', () => {
    expect(routeOrderKey([{ id: 'a' }, { id: 'b' }])).not.toBe(
      routeOrderKey([{ id: 'a' }, { id: 'c' }]),
    )
  })
})

/**
 * Reported 2026-08-25: "For some reason, it made the locked in stops
 * earlier. The list should be … starting with what is first on the route."
 *
 * Optimising from a moving origin re-answers a different question every few
 * kilometres — "the best order from HERE" rather than "the best order for
 * this trip" — so the list reshuffles as the van drives.
 */
describe('optimising while under way', () => {
  it('leaves the order alone when the route starts from our position', () => {
    expect(mayOptimize(null, true)).toBe(false)
  })

  it('still optimises from the trip’s own start point', () => {
    expect(mayOptimize(null, false)).toBe(true)
    // And the default is the planning case, so nothing else had to change.
    expect(mayOptimize(null)).toBe(true)
  })

  // A manual order still wins either way — that override exists precisely so
  // the next reply does not undo it.
  it('never overrides a hand-made order', () => {
    const manual = manualRouteOrder('k', [2, 0, 1])
    expect(mayOptimize(manual, false)).toBe(false)
    expect(mayOptimize(manual, true)).toBe(false)
  })
})
