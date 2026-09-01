import { describe, expect, it } from 'vitest'
import { stopsNeedingCountry } from './stopCountries'
import type { CorridorStopWithId } from '../hooks/useCorridorStops'

const stop = (over: Partial<CorridorStopWithId>): CorridorStopWithId =>
  ({
    id: 'a',
    name: 'Ciclopista del Garda',
    lat: 45.88,
    lng: 10.84,
    status: 'locked',
    linkedDayIds: [],
    ...over,
  }) as CorridorStopWithId

/**
 * Reported 2026-08-31: "Seems to not respond to any rebuilds… I can't enter
 * any days either!" A stop pinned by hand never had a country written, and
 * planSkeleton drops any stop without one — so it could never be given a
 * day, and the banner offering a rebuild counted it forever.
 */
describe('stops that cannot be dated for want of a country', () => {
  it('finds the hand-placed pin with no country at all', () => {
    expect(stopsNeedingCountry([stop({})]).map((s) => s.id)).toEqual(['a'])
  })

  it('leaves a stop that already has one alone', () => {
    expect(stopsNeedingCountry([stop({ country: 'IT' })])).toEqual([])
  })

  // A three-letter code fails the schema exactly as a missing one does, so
  // it needs the same repair rather than being taken at face value.
  it('repairs a country that is not two letters', () => {
    expect(stopsNeedingCountry([stop({ country: 'ITA' })])).toHaveLength(1)
  })

  /**
   * Only what the day list needs. An unlocked candidate is not on the route
   * and a done stop is behind you — geocoding either would be spending a
   * lookup to change nothing.
   */
  it('ignores stops the day list would not pack anyway', () => {
    expect(
      stopsNeedingCountry([
        stop({ id: 'b', status: 'candidate' }),
        stop({ id: 'c', doneAt: '2026-08-20T10:00:00.000Z' }),
      ]),
    ).toEqual([])
  })

  // Coordinates are the whole input to the lookup; without them there is
  // nothing to ask about.
  it('skips a stop with no usable position', () => {
    expect(
      stopsNeedingCountry([stop({ lat: Number.NaN, lng: 10.84 })]),
    ).toEqual([])
  })

  it('takes a few at a time rather than a burst of lookups', () => {
    const many = Array.from({ length: 12 }, (_, i) => stop({ id: `s${i}` }))
    expect(stopsNeedingCountry(many)).toHaveLength(5)
  })
})
