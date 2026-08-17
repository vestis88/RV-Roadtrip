import { getFirestore } from 'firebase-admin/firestore'
import { initializeApp } from 'firebase-admin/app'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  buildExploreCandidateWrites,
  buildRegionHighlightsFromCandidates,
  lockedRouteOrder,
} from './exploreCandidates.js'
import type { RegionHighlightsResponse } from './prompts/planTripSchema.js'

const PROJECT_ID = 'demo-rv-trip-planner'

beforeAll(() => {
  initializeApp({ projectId: PROJECT_ID })
})

describe('buildExploreCandidateWrites', () => {
  it('flattens regions into candidate stops, ranked within each priority tier', () => {
    const db = getFirestore()
    const tripRef = db.collection('trips').doc('trip1')
    const highlights: RegionHighlightsResponse = {
      regions: [
        {
          region: 'Bavaria',
          country: 'DE',
          reasoning: 'r',
          candidateStops: [
            { sight: 'A', town: 'Munich', country: 'DE', why: 'w', priority: 'must-see', lat: 1, lng: 1 },
            { sight: 'B', town: 'Munich', country: 'DE', why: 'w', priority: 'worth-a-detour', lat: 2, lng: 2 },
          ],
        },
        {
          region: 'Tyrol',
          country: 'AT',
          reasoning: 'r',
          candidateStops: [
            { sight: 'C', town: 'Innsbruck', country: 'AT', why: 'w', priority: 'must-see', lat: 3, lng: 3 },
          ],
        },
      ],
    }

    const { writes, added } = buildExploreCandidateWrites(tripRef, highlights, [])
    const sets = writes.filter((w) => w.op === 'set')
    expect(sets).toHaveLength(3)
    expect(added).toBe(3)

    const byName = new Map(sets.map((w) => [w.data.name as string, w.data]))
    expect(byName.get('A')).toMatchObject({
      status: 'candidate',
      priority: 'must-see',
      region: 'Bavaria',
      rank: 0,
    })
    expect(byName.get('C')).toMatchObject({
      status: 'candidate',
      priority: 'must-see',
      region: 'Tyrol',
      rank: 1,
    })
    expect(byName.get('B')).toMatchObject({
      status: 'candidate',
      priority: 'worth-a-detour',
      region: 'Bavaria',
      rank: 0,
    })
  })

  // The sight is the unit now: its own name and coordinates are the stop,
  // and the town rides along as where to sleep while seeing it.
  it('writes the sight as the stop, with its base town, interest and duration', () => {
    const db = getFirestore()
    const tripRef = db.collection('trips').doc('trip1')
    const { writes } = buildExploreCandidateWrites(
      tripRef,
      {
        regions: [
          {
            region: 'North Zealand',
            country: 'DK',
            reasoning: 'r',
            candidateStops: [
              {
                sight: 'Kronborg Castle',
                town: 'Helsingør',
                country: 'DK',
                why: 'Hamlet lived here.',
                priority: 'must-see',
                interest: 'castles',
                timeNeeded: 'half-day',
                lat: 56.04,
                lng: 12.62,
              },
            ],
          },
        ],
      },
      [],
    )

    const sets = writes.filter((w) => w.op === 'set')
    expect(sets).toHaveLength(1)
    expect(sets[0].data).toMatchObject({
      name: 'Kronborg Castle',
      baseTown: 'Helsingør',
      interest: 'castles',
      timeNeeded: 'half-day',
      lat: 56.04,
      lng: 12.62,
    })
  })

  it('drops candidates whose sight never resolved to a location', () => {
    const db = getFirestore()
    const tripRef = db.collection('trips').doc('trip1')
    const highlights: RegionHighlightsResponse = {
      regions: [
        {
          region: 'Bavaria',
          country: 'DE',
          reasoning: 'r',
          candidateStops: [
            { sight: 'Unfindable', town: 'Munich', country: 'DE', why: 'w', priority: 'must-see' },
          ],
        },
      ],
    }

    const { writes, added, unlocated } = buildExploreCandidateWrites(
      tripRef,
      highlights,
      [],
    )
    expect(writes).toHaveLength(0)
    expect(added).toBe(0)
    expect(unlocated).toBe(1)
  })

  // The change this file exists to protect (2026-08-13): a refresh used to
  // delete every candidate first, so pressing "Find more stops" after weeks
  // of curating threw away every interest level the traveler had set.
  describe('merging with what the traveler already has', () => {
    const FRESH_PASS: RegionHighlightsResponse = {
      regions: [
        {
          region: 'North Zealand',
          country: 'DK',
          reasoning: 'r',
          candidateStops: [
            { sight: 'Kronborg Castle', town: 'Helsingør', country: 'DK', why: 'w', priority: 'must-see', lat: 56.04, lng: 12.62 },
            { sight: 'Louisiana Museum', town: 'Humlebæk', country: 'DK', why: 'w', priority: 'worth-a-detour', lat: 55.97, lng: 12.54 },
          ],
        },
      ],
    }

    it('writes nothing for a sight already in the corridor, and deletes nothing', () => {
      const db = getFirestore()
      const tripRef = db.collection('trips').doc('trip1')

      const { writes, added, alreadyKnown } = buildExploreCandidateWrites(
        tripRef,
        FRESH_PASS,
        [{ name: 'Kronborg Castle', priority: 'nice-if-convenient' }],
      )

      const sets = writes.filter((w) => w.op === 'set')
      expect(writes.every((w) => w.op === 'set')).toBe(true)
      expect(sets).toHaveLength(1)
      expect(sets[0].data.name).toBe('Louisiana Museum')
      expect(added).toBe(1)
      expect(alreadyKnown).toBe(1)
    })

    // Rejections are tombstones precisely so this can happen — without them a
    // rejected stop is indistinguishable from one never suggested.
    it('does not resurrect a sight the traveler turned down', () => {
      const db = getFirestore()
      const tripRef = db.collection('trips').doc('trip1')

      const { writes, alreadyKnown } = buildExploreCandidateWrites(
        tripRef,
        FRESH_PASS,
        [
          { name: 'Kronborg Castle', priority: 'must-see' },
          { name: 'Louisiana Museum', priority: 'worth-a-detour' },
        ],
      )

      expect(writes).toHaveLength(0)
      expect(alreadyKnown).toBe(2)
    })

    // Places' own spelling is what gets stored, but Claude's varies between
    // passes and the traveler's own pins are typed by hand.
    it('matches known stops regardless of case, accents and punctuation', () => {
      const db = getFirestore()
      const tripRef = db.collection('trips').doc('trip1')

      const { added } = buildExploreCandidateWrites(
        tripRef,
        {
          regions: [
            {
              region: 'Møn',
              country: 'DK',
              reasoning: 'r',
              candidateStops: [
                { sight: 'Møns Klint', town: 'Borre', country: 'DK', why: 'w', priority: 'must-see', lat: 55, lng: 12 },
              ],
            },
          ],
        },
        [{ name: 'mons-klint', priority: 'must-see' }],
      )

      expect(added).toBe(0)
    })

    it('ranks new finds after the stops already in their tier', () => {
      const db = getFirestore()
      const tripRef = db.collection('trips').doc('trip1')

      const { writes } = buildExploreCandidateWrites(tripRef, FRESH_PASS, [
        { name: 'Frederiksborg Castle', priority: 'must-see' },
        { name: 'Roskilde Cathedral', priority: 'must-see' },
      ])

      const sets = writes.filter((w) => w.op === 'set')
      const kronborg = sets.find((w) => w.data.name === 'Kronborg Castle')
      expect(kronborg?.data.rank).toBe(2)
      // A tier nobody has anything in yet still starts at zero.
      const louisiana = sets.find((w) => w.data.name === 'Louisiana Museum')
      expect(louisiana?.data.rank).toBe(0)
    })

    it('writes a sight only once when two regions both propose it', () => {
      const db = getFirestore()
      const tripRef = db.collection('trips').doc('trip1')

      const { writes, added } = buildExploreCandidateWrites(
        tripRef,
        {
          regions: [
            {
              region: 'North Zealand',
              country: 'DK',
              reasoning: 'r',
              candidateStops: [
                { sight: 'Kronborg Castle', town: 'Helsingør', country: 'DK', why: 'w', priority: 'must-see', lat: 56.04, lng: 12.62 },
              ],
            },
            {
              region: 'Öresund',
              country: 'DK',
              reasoning: 'r',
              candidateStops: [
                { sight: 'Kronborg Castle', town: 'Helsingborg', country: 'DK', why: 'w', priority: 'worth-a-detour', lat: 56.04, lng: 12.62 },
              ],
            },
          ],
        },
        [],
      )

      expect(writes).toHaveLength(1)
      expect(added).toBe(1)
    })
  })
})

describe('buildRegionHighlightsFromCandidates', () => {
  it('groups by region, sorted by priority tier then rank', () => {
    const result = buildRegionHighlightsFromCandidates([
      { name: 'B', lat: 2, lng: 2, country: 'DE', region: 'Bavaria', priority: 'worth-a-detour', rank: 0 },
      { name: 'A', lat: 1, lng: 1, country: 'DE', region: 'Bavaria', priority: 'must-see', rank: 0 },
      { name: 'C', lat: 3, lng: 3, country: 'AT', region: 'Tyrol', priority: 'must-see', rank: 0 },
    ])

    expect(result.regions).toHaveLength(2)
    const bavaria = result.regions.find((r) => r.region === 'Bavaria')
    expect(bavaria?.candidateStops.map((c) => c.sight)).toEqual(['A', 'B'])
  })

  // The reverse of the write above: the outline phase has to see the sight,
  // where to sleep for it, and what it costs in time, or a curated trip
  // would be paced as if every stop were free.
  it('hands the sight, its base town, interest and duration back to the outline', () => {
    const result = buildRegionHighlightsFromCandidates([
      {
        name: 'Kronborg Castle',
        lat: 56.04,
        lng: 12.62,
        country: 'DK',
        region: 'North Zealand',
        priority: 'must-see',
        baseTown: 'Helsingør',
        interest: 'castles',
        timeNeeded: 'half-day',
      },
    ])

    expect(result.regions[0].candidateStops[0]).toMatchObject({
      sight: 'Kronborg Castle',
      town: 'Helsingør',
      interest: 'castles',
      timeNeeded: 'half-day',
    })
  })

  // Every stop curated before sights led the route is a town whose own name
  // is the whole story — it stands as both rather than having a base town
  // invented for it, and carries no fabricated duration into the pacing.
  it('treats a stop with no base town as its own sight, with nothing invented', () => {
    const result = buildRegionHighlightsFromCandidates([
      { name: 'Otta', lat: 61.77, lng: 9.54, country: 'NO', region: 'Gudbrandsdalen' },
    ])

    const candidate = result.regions[0].candidateStops[0]
    expect(candidate).toMatchObject({ sight: 'Otta', town: 'Otta' })
    expect(candidate.timeNeeded).toBeUndefined()
    expect(candidate.interest).toBeUndefined()
  })

  it('falls back to a per-country catch-all region when no region is recorded', () => {
    const result = buildRegionHighlightsFromCandidates([
      { name: 'Rescan find', lat: 1, lng: 1, country: 'NO' },
    ])

    expect(result.regions).toHaveLength(1)
    expect(result.regions[0].region).toBe('Added stops (NO)')
    expect(result.regions[0].candidateStops[0]).toMatchObject({
      sight: 'Rescan find',
      country: 'NO',
      priority: 'worth-a-detour',
    })
  })

  it('skips a stop with no country rather than failing the whole commit', () => {
    const result = buildRegionHighlightsFromCandidates([
      { name: 'No country', lat: 1, lng: 1 },
      { name: 'Has country', lat: 2, lng: 2, country: 'FR' },
    ])

    const allSights = result.regions.flatMap((r) =>
      r.candidateStops.map((c) => c.sight),
    )
    expect(allSights).toEqual(['Has country'])
  })

  it('returns no regions for an empty candidate list', () => {
    expect(buildRegionHighlightsFromCandidates([]).regions).toEqual([])
  })
})

/**
 * The order the traveler committed to on the map, worked out by Google
 * against real roads — carried into the route phase, which cannot derive it.
 *
 * Reported as a Denmark→Baltics trip routed north through Sweden and around
 * the Gulf of Bothnia. Ordering the explore map fixed the drawing; without
 * this the plan request carries nothing but a trip id, so pressing "Generate
 * full plan" put the detour straight back.
 */
describe('lockedRouteOrder', () => {
  it('names the locked stops in routeIndex order', () => {
    expect(
      lockedRouteOrder([
        { name: 'Saaremaa', lat: 58.2, lng: 22.5, status: 'locked', routeIndex: 1 },
        { name: 'Öland', lat: 56.7, lng: 16.5, status: 'locked', routeIndex: 0 },
      ]),
    ).toEqual(['Öland', 'Saaremaa'])
  })

  it('ignores stops the traveler has not locked in', () => {
    expect(
      lockedRouteOrder([
        { name: 'Kept', lat: 56.7, lng: 16.5, status: 'locked', routeIndex: 0 },
        { name: 'Merely suggested', lat: 57, lng: 17, status: 'candidate', routeIndex: 1 },
      ]),
    ).toEqual(['Kept'])
  })

  // A stop that has never been drawn on a route has no position. Sorting it
  // to the FRONT would invent exactly the kind of order this exists to stop
  // being invented, so it goes last.
  it('puts a stop with no routeIndex last rather than first', () => {
    expect(
      lockedRouteOrder([
        { name: 'Never drawn', lat: 57, lng: 17, status: 'locked' },
        { name: 'Second', lat: 58, lng: 18, status: 'locked', routeIndex: 1 },
        { name: 'First', lat: 56, lng: 16, status: 'locked', routeIndex: 0 },
      ]),
    ).toEqual(['First', 'Second', 'Never drawn'])
  })

  it('is empty for a trip nobody has explored', () => {
    expect(lockedRouteOrder([])).toEqual([])
  })
})
