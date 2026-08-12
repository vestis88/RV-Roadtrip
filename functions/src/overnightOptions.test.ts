import { describe, expect, it } from 'vitest'
import type { OvernightStopCandidate } from '@rv/shared'
import { pickDefaultOvernight } from './overnightOptions.js'
import { __testing, nearestOsmPlaces, type OsmOvernightPlace } from './overpassApi.js'

const { dedupePoints, toPlace, overpassClauses } = __testing

function option(
  type: OvernightStopCandidate['type'],
  name: string,
): OvernightStopCandidate {
  return {
    name,
    type,
    lat: 60,
    lng: 10,
    country: 'SE',
    description: 'x',
    source: type === 'campsite' ? 'places' : 'osm',
  }
}

// The traveler's stated preference: stellplatz where there is one.
describe('pickDefaultOvernight', () => {
  it('prefers a named stellplatz over a campsite', () => {
    const picked = pickDefaultOvernight([
      option('campsite', 'Krossinsee Camping'),
      option('stellplatz', 'Wohnmobilstellplatz am Hafen'),
    ])
    expect(picked?.name).toBe('Wohnmobilstellplatz am Hafen')
  })

  // OSM stellplatz are frequently unnamed and carry nothing that says whether
  // the site still operates. A rated campsite is the better thing to commit a
  // night to — the anonymous point stays in the options list either way.
  it('falls back to a campsite when the only stellplatz is anonymous', () => {
    const picked = pickDefaultOvernight([
      option('campsite', 'Krossinsee Camping'),
      option('stellplatz', 'Unnamed motorhome stopover'),
    ])
    expect(picked?.name).toBe('Krossinsee Camping')
  })

  it('takes the anonymous stellplatz when there is no campsite at all', () => {
    const picked = pickDefaultOvernight([
      option('stellplatz', 'Unnamed motorhome stopover'),
    ])
    expect(picked?.type).toBe('stellplatz')
  })

  // Whether you may actually spend the night in a free parking spot is a
  // question about local signage and national law. It is offered, never
  // chosen on the traveler's behalf.
  it('never commits the trip to a free parking spot', () => {
    expect(pickDefaultOvernight([option('wild', 'Lay-by on the 108')])).toBeNull()
  })

  it('reports nothing rather than guessing when there are no options', () => {
    expect(pickDefaultOvernight([])).toBeNull()
  })
})

describe('overpass corridor query', () => {
  // The reason a 60-day trip is now affordable: consecutive days in the same
  // town (every rest day, every two-night stop) collapse into one circle.
  it('collapses points within ~11km of each other', () => {
    expect(
      dedupePoints([
        { lat: 52.52, lng: 13.405 },
        { lat: 52.521, lng: 13.406 },
        { lat: 55.6, lng: 12.99 },
      ]),
    ).toHaveLength(2)
  })

  it('keeps genuinely separate towns apart', () => {
    expect(
      dedupePoints([
        { lat: 52.52, lng: 13.405 },
        { lat: 53.55, lng: 9.99 },
      ]),
    ).toHaveLength(2)
  })

  // The relaxed filter is the fix for thin stellplatz results: requiring
  // caravan_site=motorhome_stopover on top of tourism=caravan_site discarded
  // every site whose mapper tagged only the parent.
  it('asks for caravan sites without requiring the stopover sub-tag', () => {
    const clauses = overpassClauses({ lat: 52.5, lng: 13.4 }, 30000)
    expect(clauses).toContain('["tourism"="caravan_site"]')
    expect(clauses).not.toContain('"caravan_site"="motorhome_stopover"')
  })

  // Every motorway service area carries highway=rest_area; including it would
  // bury the places someone actually wants.
  it('does not ask for motorway rest areas', () => {
    expect(overpassClauses({ lat: 52.5, lng: 13.4 }, 30000)).not.toContain(
      'rest_area',
    )
  })

  it('reads a caravan site as a stellplatz and free parking as wild', () => {
    expect(
      toPlace({ type: 'node', id: 1, lat: 1, lon: 2, tags: { tourism: 'caravan_site' } })
        ?.kind,
    ).toBe('stellplatz')
    expect(
      toPlace({
        type: 'node',
        id: 2,
        lat: 1,
        lon: 2,
        tags: { amenity: 'parking', motorhome: 'yes' },
      })?.kind,
    ).toBe('wild')
  })

  it('takes a way\'s center, since a caravan site is usually an area', () => {
    const place = toPlace({
      type: 'way',
      id: 3,
      center: { lat: 55.1, lon: 12.2 },
      tags: { tourism: 'caravan_site', name: 'Hafen-Stellplatz' },
    })
    expect(place).toMatchObject({ lat: 55.1, lng: 12.2, name: 'Hafen-Stellplatz' })
  })

  it('says so when a site is free', () => {
    const place = toPlace({
      type: 'node',
      id: 4,
      lat: 1,
      lon: 2,
      tags: { tourism: 'caravan_site', fee: 'no' },
    })
    expect(place?.free).toBe(true)
  })
})

describe('nearestOsmPlaces', () => {
  const place = (
    overrides: Partial<OsmOvernightPlace> & { lat: number },
  ): OsmOvernightPlace => ({
    name: 'somewhere',
    kind: 'stellplatz',
    lng: 10,
    description: 'x',
    free: false,
    explicitStopover: false,
    ...overrides,
  })

  const NEAR = { lat: 60, lng: 10 }

  it('returns only the kind asked for', () => {
    const found = nearestOsmPlaces(
      [place({ lat: 60.01 }), place({ lat: 60.02, kind: 'wild' })],
      NEAR,
      'wild',
      3,
    )
    expect(found).toHaveLength(1)
    expect(found[0].kind).toBe('wild')
  })

  // Where the relaxed tag filter pays for itself: a site that says outright
  // it is a motorhome stopover beats a bare caravan_site slightly nearer.
  it('ranks an explicit motorhome stopover above a bare caravan site', () => {
    const found = nearestOsmPlaces(
      [
        place({ lat: 60.01, name: 'bare' }),
        place({ lat: 60.05, name: 'explicit', explicitStopover: true }),
      ],
      NEAR,
      'stellplatz',
      3,
    )
    expect(found[0].name).toBe('explicit')
  })

  it('sorts by distance among equally-tagged sites', () => {
    const found = nearestOsmPlaces(
      [place({ lat: 60.2, name: 'far' }), place({ lat: 60.01, name: 'near' })],
      NEAR,
      'stellplatz',
      3,
    )
    expect(found.map((p) => p.name)).toEqual(['near', 'far'])
  })

  // A corridor query returns the whole route's worth of sites; each day must
  // only see the ones actually near it.
  it('drops sites belonging to a different part of the route', () => {
    expect(
      nearestOsmPlaces([place({ lat: 65, name: 'other end' })], NEAR, 'stellplatz', 3),
    ).toEqual([])
  })

  it('respects the limit', () => {
    const found = nearestOsmPlaces(
      [place({ lat: 60.01 }), place({ lat: 60.02 }), place({ lat: 60.03 })],
      NEAR,
      'stellplatz',
      2,
    )
    expect(found).toHaveLength(2)
  })
})
