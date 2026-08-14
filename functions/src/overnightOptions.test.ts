import { describe, expect, it } from 'vitest'
import type { OvernightStopCandidate } from '@rv/shared'
import {
  pickDefaultOvernight,
  type OvernightChoiceContext,
} from './overnightOptions.js'
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

/**
 * A night in a country that permits free camping, with tank capacity to
 * spare — the case where a free spot is what the traveler asked for.
 */
const OFF_GRID: OvernightChoiceContext = {
  freeCampingPermitted: true,
  offGridNightsRemaining: 3,
  restDay: false,
}

describe('pickDefaultOvernight', () => {
  // The whole point of the 2026-08-13 change: the traveler is equipped for
  // it, the country allows it, so this is the night they wanted.
  it('commits a free spot where the country allows it and the tanks are fine', () => {
    const picked = pickDefaultOvernight(
      [
        option('campsite', 'Krossinsee Camping'),
        option('stellplatz', 'Wohnmobilstellplatz am Hafen'),
        option('wild', 'Lay-by on the 108'),
      ],
      OFF_GRID,
    )
    expect(picked?.name).toBe('Lay-by on the 108')
  })

  // Germany outside designated spots, Croatia, Italy. Nothing about the
  // trip's own preferences overrides the country's law.
  it('never commits a free spot where the country prohibits it', () => {
    const picked = pickDefaultOvernight(
      [option('wild', 'Lay-by on the 108')],
      { ...OFF_GRID, freeCampingPermitted: false },
    )
    expect(picked).toBeNull()
  })

  // An unresearched country arrives here as "not permitted" (see
  // freeCampingPolicy), which is the same path as an outright prohibition:
  // the night falls back to something serviced rather than being skipped.
  it('falls back to a campsite rather than nothing where free is not permitted', () => {
    const picked = pickDefaultOvernight(
      [option('campsite', 'Krossinsee Camping'), option('wild', 'Lay-by')],
      { ...OFF_GRID, freeCampingPermitted: false },
    )
    expect(picked?.name).toBe('Krossinsee Camping')
  })

  // The constraint that actually binds: fresh water out, grey/black full.
  it('requires facilities once the off-grid tolerance is spent', () => {
    const picked = pickDefaultOvernight(
      [option('wild', 'Lay-by on the 108'), option('campsite', 'Krossinsee Camping')],
      { ...OFF_GRID, offGridNightsRemaining: 0 },
    )
    expect(picked?.name).toBe('Krossinsee Camping')
  })

  // A rest day is a whole day parked in one place — the day the tanks empty
  // fastest and the day a stellplatz's short max-stay bites.
  it('gives a rest day a serviced stop even mid-run', () => {
    const picked = pickDefaultOvernight(
      [option('wild', 'Lay-by on the 108'), option('campsite', 'Krossinsee Camping')],
      { ...OFF_GRID, restDay: true },
    )
    expect(picked?.name).toBe('Krossinsee Camping')
  })

  // Servicing is due and there is nowhere to do it. A real place beats a
  // town-centre intersection; applyOvernightOptions keeps the tanks due, so
  // the requirement carries into the next day instead of being dropped.
  it('still takes the free spot when servicing is due but unavailable', () => {
    const picked = pickDefaultOvernight([option('wild', 'Lay-by on the 108')], {
      ...OFF_GRID,
      offGridNightsRemaining: 0,
    })
    expect(picked?.name).toBe('Lay-by on the 108')
  })

  // The traveler's stated preference among serviced options, unchanged.
  it('prefers a named stellplatz over a campsite', () => {
    const picked = pickDefaultOvernight(
      [
        option('campsite', 'Krossinsee Camping'),
        option('stellplatz', 'Wohnmobilstellplatz am Hafen'),
      ],
      { ...OFF_GRID, offGridNightsRemaining: 0 },
    )
    expect(picked?.name).toBe('Wohnmobilstellplatz am Hafen')
  })

  // OSM stellplatz are frequently unnamed and carry nothing that says whether
  // the site still operates. A rated campsite is the better thing to commit a
  // night to — the anonymous point stays in the options list either way.
  it('falls back to a campsite when the only stellplatz is anonymous', () => {
    const picked = pickDefaultOvernight(
      [
        option('campsite', 'Krossinsee Camping'),
        option('stellplatz', 'Unnamed motorhome stopover'),
      ],
      { ...OFF_GRID, offGridNightsRemaining: 0 },
    )
    expect(picked?.name).toBe('Krossinsee Camping')
  })

  it('takes the anonymous stellplatz when there is no campsite at all', () => {
    const picked = pickDefaultOvernight(
      [option('stellplatz', 'Unnamed motorhome stopover')],
      { ...OFF_GRID, offGridNightsRemaining: 0 },
    )
    expect(picked?.type).toBe('stellplatz')
  })

  it('reports nothing rather than guessing when there are no options', () => {
    expect(pickDefaultOvernight([], OFF_GRID)).toBeNull()
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

  // Reported 2026-08-14: three harbour stellplatz in North Zealand all read
  // "arrive/depart any time, minimal facilities, short max stay" — identical,
  // because the only free-text field OSM has is rarely set and everything fell
  // through to one boilerplate sentence. The facts were in the response all
  // along.
  it('describes a site from the facilities its mapper recorded', () => {
    const place = toPlace({
      type: 'node',
      id: 10,
      lat: 1,
      lon: 2,
      tags: {
        tourism: 'caravan_site',
        name: 'Nivaa Havn',
        drinking_water: 'yes',
        sanitary_dump_station: 'yes',
        capacity: '12',
        maxstay: '3 days',
      },
    })

    expect(place?.description).toContain('fresh water')
    expect(place?.description).toContain('dump station')
    expect(place?.description).toContain('12 pitches')
    expect(place?.description).toContain('max stay 3 days')
  })

  it('two sites with different facilities no longer read identically', () => {
    const serviced = toPlace({
      type: 'node',
      id: 11,
      lat: 1,
      lon: 2,
      tags: { tourism: 'caravan_site', drinking_water: 'yes', shower: 'yes' },
    })
    const bare = toPlace({
      type: 'node',
      id: 12,
      lat: 1,
      lon: 2,
      tags: { tourism: 'caravan_site', capacity: '4' },
    })

    expect(serviced?.description).not.toBe(bare?.description)
  })

  // Asserting "minimal facilities" about a site nobody has surveyed is a claim
  // OSM never made, and it read exactly like a site that had been surveyed and
  // found bare.
  it('admits when nothing is recorded rather than inventing detail', () => {
    const place = toPlace({
      type: 'node',
      id: 13,
      lat: 1,
      lon: 2,
      tags: { tourism: 'caravan_site' },
    })

    expect(place?.description).toMatch(/no facilities recorded/i)
    expect(place?.description).not.toMatch(/minimal facilities/i)
  })

  // A mapper who wrote prose about the place knows more than a tag list does.
  it('prefers the mapper\'s own description when there is one', () => {
    const place = toPlace({
      type: 'node',
      id: 14,
      lat: 1,
      lon: 2,
      tags: {
        tourism: 'caravan_site',
        description: 'Quiet harbour berth, pay at the kiosk.',
        drinking_water: 'yes',
      },
    })

    expect(place?.description).toBe('Quiet harbour berth, pay at the kiosk.')
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
