import { describe, expect, it } from 'vitest'
import { mostSpecific } from './reverseGeocode'

type Result = { types: string[]; formatted_address: string }

function pick(results: Result[]): string | undefined {
  return mostSpecific(
    results as unknown as google.maps.GeocoderResult[],
  )?.formatted_address
}

/**
 * The model is given no coordinates — deliberately, so it cannot invent
 * distances — which makes this string the ENTIRE statement of where the
 * search circle is. Its precision has to match the circle's size, and until
 * 2026-08-22 nothing made it.
 */
describe('naming the map centre for a search that has no coordinates', () => {
  // The reported failure, reconstructed: a point in the middle of Plansee is
  // in no locality, so the old ladder fell through to the Bezirk and told a
  // 7 km search it was looking at a 1,200 km² district. It answered with the
  // district's highlights, all more than 7 km out, and all were discarded.
  it('prefers the lake it is floating on over the district containing it', () => {
    expect(
      pick([
        { types: ['plus_code'], formatted_address: 'FR9V+2X Breitenwang' },
        { types: ['natural_feature'], formatted_address: 'Plansee, Austria' },
        {
          types: ['administrative_area_level_2', 'political'],
          formatted_address: 'Reutte, Austria',
        },
        { types: ['country', 'political'], formatted_address: 'Austria' },
      ]),
    ).toBe('Plansee, Austria')
  })

  it('never answers with a plus code, however precise', () => {
    expect(
      pick([
        { types: ['plus_code'], formatted_address: 'FR9V+2X Breitenwang' },
        {
          types: ['administrative_area_level_1', 'political'],
          formatted_address: 'Tyrol, Austria',
        },
      ]),
    ).toBe('Tyrol, Austria')
  })

  // The original intent, unchanged: the town, not the street address of
  // whatever pixel the centre happened to land on.
  it('still prefers the town over a road', () => {
    expect(
      pick([
        { types: ['route'], formatted_address: 'Slotsgade, Hillerød' },
        { types: ['locality', 'political'], formatted_address: 'Hillerød, Denmark' },
      ]),
    ).toBe('Hillerød, Denmark')
  })

  // ...and not the country either.
  it('prefers anything at all over a country', () => {
    expect(
      pick([
        { types: ['country', 'political'], formatted_address: 'Denmark' },
        { types: ['locality', 'political'], formatted_address: 'Hillerød, Denmark' },
      ]),
    ).toBe('Hillerød, Denmark')
  })

  it('falls back to a road when there is nothing named at all', () => {
    expect(
      pick([
        { types: ['route'], formatted_address: 'Fernpassstraße, Austria' },
        {
          types: ['administrative_area_level_2', 'political'],
          formatted_address: 'Reutte, Austria',
        },
      ]),
    ).toBe('Fernpassstraße, Austria')
  })

  it('gives up rather than guessing when nothing is recognisable', () => {
    expect(pick([{ types: ['plus_code'], formatted_address: 'FR9V+2X' }])).toBeUndefined()
  })
})
