import { getFirestore } from 'firebase-admin/firestore'
import { initializeApp } from 'firebase-admin/app'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createTripForUser } from './trips.js'
import type { CorridorStop } from '@rv/shared'

const PROJECT_ID = 'demo-rv-trip-planner'

beforeAll(() => {
  initializeApp({ projectId: PROJECT_ID })
  getFirestore().settings({ ignoreUndefinedProperties: true })
})

const generateRegionHighlightsMock = vi.fn()
vi.mock('./prompts/planTrip.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./prompts/planTrip.js')>()
  return {
    ...actual,
    generateRegionHighlights: (...args: unknown[]) =>
      generateRegionHighlightsMock(...args),
  }
})

const FIXTURE_HIGHLIGHTS = {
  regions: [
    {
      region: 'Gudbrandsdalen',
      country: 'NO',
      reasoning: 'r',
      candidateStops: [
        { town: 'Otta', country: 'NO', why: 'w', priority: 'must-see' as const, lat: 61.77, lng: 9.54 },
      ],
    },
  ],
}

describe('generateExploreHighlightsForTrip', () => {
  it('writes candidate corridor stops from the highlights response', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidExploreGenA')
    generateRegionHighlightsMock.mockReset().mockResolvedValue(FIXTURE_HIGHLIGHTS)

    const { generateExploreHighlightsForTrip } = await import(
      './exploreHighlightsCallable.js'
    )
    const result = await generateExploreHighlightsForTrip(tripId)

    expect(result.candidateCount).toBe(1)
    const snap = await db.collection('trips').doc(tripId).collection('corridorStops').get()
    const stops = snap.docs.map((d) => d.data() as CorridorStop)
    expect(stops).toHaveLength(1)
    expect(stops[0]).toMatchObject({
      name: 'Otta',
      status: 'candidate',
      priority: 'must-see',
      region: 'Gudbrandsdalen',
      rank: 0,
    })
  })

  it('clears planMeta.exploreStatus back to idle even after a failure', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidExploreGenFail')
    generateRegionHighlightsMock.mockReset().mockRejectedValue(new Error('boom'))

    const { generateExploreHighlightsForTrip } = await import(
      './exploreHighlightsCallable.js'
    )
    await expect(generateExploreHighlightsForTrip(tripId)).rejects.toThrow('boom')

    const snap = await db.collection('trips').doc(tripId).get()
    expect(snap.data()?.planMeta?.exploreStatus).toBe('idle')
  })

  it('rejects a second concurrent call while one is already generating', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidExploreGenConcurrent')
    let resolveFirst: (value: typeof FIXTURE_HIGHLIGHTS) => void = () => {}
    generateRegionHighlightsMock.mockReset().mockImplementation(
      () => new Promise((resolve) => (resolveFirst = resolve)),
    )

    const { generateExploreHighlightsForTrip } = await import(
      './exploreHighlightsCallable.js'
    )
    const first = generateExploreHighlightsForTrip(tripId)
    // Let the transaction inside the first call actually claim the guard
    // before firing the second — otherwise both could race the read.
    await new Promise((resolve) => setTimeout(resolve, 50))

    await expect(generateExploreHighlightsForTrip(tripId)).rejects.toThrow(
      'Already finding great stops',
    )

    resolveFirst(FIXTURE_HIGHLIGHTS)
    await first

    const snap = await db.collection('trips').doc(tripId).get()
    expect(snap.data()?.planMeta?.exploreStatus).toBe('idle')
  })

  it('reclaims a lock left stuck on "generating" by a crashed prior run', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidExploreGenStaleLock')
    generateRegionHighlightsMock.mockReset().mockResolvedValue(FIXTURE_HIGHLIGHTS)

    // Simulate a previous invocation that claimed the lock and then never
    // reached its own `finally` (killed by the platform's timeout, or
    // crashed) — the lock is stuck 'generating' with an old timestamp,
    // exactly what a genuinely abandoned run looks like in Firestore.
    const staleTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    await db.collection('trips').doc(tripId).update({
      'planMeta.exploreStatus': 'generating',
      'planMeta.exploreStatusUpdatedAt': staleTimestamp,
    })

    const { generateExploreHighlightsForTrip } = await import(
      './exploreHighlightsCallable.js'
    )
    const result = await generateExploreHighlightsForTrip(tripId)

    expect(result.candidateCount).toBe(1)
    const snap = await db.collection('trips').doc(tripId).get()
    expect(snap.data()?.planMeta?.exploreStatus).toBe('idle')
  })

  it('does not reclaim a lock that is still recent', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidExploreGenFreshLock')
    generateRegionHighlightsMock.mockReset().mockResolvedValue(FIXTURE_HIGHLIGHTS)

    const recentTimestamp = new Date(Date.now() - 30 * 1000).toISOString()
    await db.collection('trips').doc(tripId).update({
      'planMeta.exploreStatus': 'generating',
      'planMeta.exploreStatusUpdatedAt': recentTimestamp,
    })

    const { generateExploreHighlightsForTrip } = await import(
      './exploreHighlightsCallable.js'
    )
    await expect(generateExploreHighlightsForTrip(tripId)).rejects.toThrow(
      'Already finding great stops',
    )
  })
})
