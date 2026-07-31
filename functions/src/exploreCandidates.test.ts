import { getFirestore } from 'firebase-admin/firestore'
import { initializeApp } from 'firebase-admin/app'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  buildExploreCandidateWrites,
  buildRegionHighlightsFromCandidates,
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
            { town: 'A', country: 'DE', why: 'w', priority: 'must-see', lat: 1, lng: 1 },
            { town: 'B', country: 'DE', why: 'w', priority: 'worth-a-detour', lat: 2, lng: 2 },
          ],
        },
        {
          region: 'Tyrol',
          country: 'AT',
          reasoning: 'r',
          candidateStops: [
            { town: 'C', country: 'AT', why: 'w', priority: 'must-see', lat: 3, lng: 3 },
          ],
        },
      ],
    }

    const writes = buildExploreCandidateWrites(tripRef, highlights, [])
    const sets = writes.filter((w) => w.op === 'set')
    expect(sets).toHaveLength(3)

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

  it('drops candidates that never geocoded', () => {
    const db = getFirestore()
    const tripRef = db.collection('trips').doc('trip1')
    const highlights: RegionHighlightsResponse = {
      regions: [
        {
          region: 'Bavaria',
          country: 'DE',
          reasoning: 'r',
          candidateStops: [
            { town: 'Ungeocoded', country: 'DE', why: 'w', priority: 'must-see' },
          ],
        },
      ],
    }

    const writes = buildExploreCandidateWrites(tripRef, highlights, [])
    expect(writes.filter((w) => w.op === 'set')).toHaveLength(0)
  })

  it('deletes every existing candidate ref passed in', () => {
    const db = getFirestore()
    const tripRef = db.collection('trips').doc('trip1')
    const existingRef = tripRef.collection('corridorStops').doc('old1')
    const highlights: RegionHighlightsResponse = { regions: [] }

    const writes = buildExploreCandidateWrites(tripRef, highlights, [existingRef])
    expect(writes).toEqual([{ op: 'delete', ref: existingRef }])
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
    expect(bavaria?.candidateStops.map((c) => c.town)).toEqual(['A', 'B'])
  })

  it('falls back to a per-country catch-all region when no region is recorded', () => {
    const result = buildRegionHighlightsFromCandidates([
      { name: 'Rescan find', lat: 1, lng: 1, country: 'NO' },
    ])

    expect(result.regions).toHaveLength(1)
    expect(result.regions[0].region).toBe('Added stops (NO)')
    expect(result.regions[0].candidateStops[0]).toMatchObject({
      town: 'Rescan find',
      country: 'NO',
      priority: 'worth-a-detour',
    })
  })

  it('skips a stop with no country rather than failing the whole commit', () => {
    const result = buildRegionHighlightsFromCandidates([
      { name: 'No country', lat: 1, lng: 1 },
      { name: 'Has country', lat: 2, lng: 2, country: 'FR' },
    ])

    const allTowns = result.regions.flatMap((r) => r.candidateStops.map((c) => c.town))
    expect(allTowns).toEqual(['Has country'])
  })

  it('returns no regions for an empty candidate list', () => {
    expect(buildRegionHighlightsFromCandidates([]).regions).toEqual([])
  })
})
