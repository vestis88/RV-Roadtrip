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

/**
 * Reported twice on 2026-09-01, the second time an hour after the geocoder
 * was supposed to have fixed it: "3 of them are still having their country
 * looked up". Depending on a network call for the one field that decides
 * whether a stop can exist in the day list at all was the mistake — on a
 * phone at a campsite the call is exactly what fails.
 */
describe('borrowing a country from the stops around a pin', () => {
  const at = (
    id: string,
    lat: number,
    lng: number,
    country?: string,
  ): CorridorStopWithId =>
    ({ id, name: id, lat, lng, status: 'locked', linkedDayIds: [], ...(country ? { country } : {}) }) as CorridorStopWithId

  it('takes the country of the nearest stop that has one', async () => {
    const { countryFromNeighbours } = await import('./stopCountries')
    expect(
      countryFromNeighbours({ lat: 45.88, lng: 10.84 }, [
        at('near', 45.89, 10.85, 'IT'),
        at('far', 47.5, 11.1, 'AT'),
      ]),
    ).toBe('IT')
  })

  // Nearest, not first: a list in no particular order must not decide this.
  it('prefers the closer of two candidates', async () => {
    const { countryFromNeighbours } = await import('./stopCountries')
    expect(
      countryFromNeighbours({ lat: 46.5, lng: 11.0 }, [
        at('a', 46.9, 11.0, 'AT'),
        at('b', 46.55, 11.0, 'IT'),
      ]),
    ).toBe('IT')
  })

  /**
   * The radius is the whole of what makes this a safe guess rather than a
   * wild one. Nothing within 50 km means nothing to borrow from.
   */
  it('says nothing when the nearest known stop is far away', async () => {
    const { countryFromNeighbours } = await import('./stopCountries')
    expect(
      countryFromNeighbours({ lat: 45.88, lng: 10.84 }, [
        at('oslo', 59.91, 10.75, 'NO'),
      ]),
    ).toBeUndefined()
  })

  it('ignores stops that have no country to lend', async () => {
    const { countryFromNeighbours } = await import('./stopCountries')
    expect(
      countryFromNeighbours({ lat: 45.88, lng: 10.84 }, [at('a', 45.89, 10.85)]),
    ).toBeUndefined()
  })
})
