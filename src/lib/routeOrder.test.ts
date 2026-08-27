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
 * An order is only an answer to "best order from HERE".
 *
 * Reported 2026-08-26: "it's jumping around, for some reason putting
 * Kronplatz ahead of Seiser Alm, even though we are at Seiser Alm." Keyed on
 * the stops alone, an order worked out in one valley was indistinguishable
 * from one worked out in another and got applied just the same.
 */
describe('keying an order to where it was worked out', () => {
  const from = { lat: 46.53, lng: 11.6 }

  it('is the same key from the same place', () => {
    expect(routeOrderKey(stops, from)).toBe(routeOrderKey(stops, from))
  })

  it('is a different key from somewhere else', () => {
    expect(routeOrderKey(stops, from)).not.toBe(
      routeOrderKey(stops, { lat: 46.74, lng: 11.94 }),
    )
  })

  // The origin is already snapped to a ~1 km grid before it gets here, so
  // this must not turn a metre of drift into a new key on its own.
  it('ignores movement below its own resolution', () => {
    expect(routeOrderKey(stops, from)).toBe(
      routeOrderKey(stops, { lat: 46.5301, lng: 11.6002 }),
    )
  })

  // Planning from the trip's own start point keeps the plain key.
  it('says nothing about an origin when there is none', () => {
    expect(routeOrderKey(stops)).toBe('a,b,c')
  })

  /**
   * And an order from elsewhere is not applied. This is the whole point: a
   * stale answer silently reordering the list is worse than no answer.
   */
  it('does not apply an order worked out somewhere else', () => {
    const here = routeOrderKey(stops, from)
    const elsewhere = routeOrderKey(stops, { lat: 46.74, lng: 11.94 })
    const order = { key: elsewhere, order: [2, 0, 1] }
    expect(applyRouteOrder(stops, order, here)).toBe(stops)
  })
})

/**
 * Optimisation was briefly disabled while routing from the traveler's own
 * position (2026-08-25), to stop the order shifting as they drove. That was
 * wrong in a way only the road showed: with Google not reordering, the order
 * fell back to a projection from the trip's START point, which ignores where
 * the van is. Optimising from the right place is the answer, not optimising
 * less.
 */
describe('optimising while under way', () => {
  it('optimises wherever the route starts from', () => {
    expect(mayOptimize(null)).toBe(true)
  })

  // A manual order still wins — that override exists precisely so the next
  // reply does not undo it.
  it('never overrides a hand-made order', () => {
    expect(mayOptimize(manualRouteOrder('k', [2, 0, 1]))).toBe(false)
  })
})
