import { getFirestore } from 'firebase-admin/firestore'
import { initializeApp } from 'firebase-admin/app'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createTripForUser } from './trips.js'

const PROJECT_ID = 'demo-rv-trip-planner'

beforeAll(() => {
  initializeApp({ projectId: PROJECT_ID })
  getFirestore().settings({ ignoreUndefinedProperties: true })
})

async function waitFor<T>(
  fn: () => Promise<T | undefined>,
  timeoutMs = 10_000,
): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const result = await fn()
    if (result !== undefined) return result
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('Timed out waiting for condition')
}

// 'fromExploreCandidates' (explore mode's commit step, 2026-07-30): unlike
// 'full', which always attempts the real Claude pipeline (see
// generatePlan.test.ts's own credential-less-failure test), this kind can
// fail BEFORE any Claude call — deterministically, with no credentials
// needed — when there's nothing to seed from. That's tested directly here;
// the "candidates exist, pipeline gets attempted" path reuses the same
// generic credential-less-failure shape generatePlan.test.ts already
// covers for 'full', so it isn't re-asserted in detail here.
describe('generatePlan: fromExploreCandidates', () => {
  it('fails clearly, with no Claude call, when there are no candidates to build from', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidExploreCommitEmpty')

    await db.collection('planRequests').add({
      tripId,
      kind: 'fromExploreCandidates',
      status: 'pending',
    })

    const trip = await waitFor(async () => {
      const snap = await db.collection('trips').doc(tripId).get()
      const data = snap.data()
      return data?.planMeta?.status === 'error' ? data : undefined
    })

    expect(trip.planMeta.error).toContain('No candidate stops')
  })

  it('attempts the real pipeline once candidates exist', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidExploreCommitReal')
    await db
      .collection('trips')
      .doc(tripId)
      .collection('corridorStops')
      .add({
        name: 'Otta',
        lat: 61.77,
        lng: 9.54,
        country: 'NO',
        status: 'candidate',
        linkedDayIds: [],
        priority: 'must-see',
        region: 'Gudbrandsdalen',
        rank: 0,
      })

    await db.collection('planRequests').add({
      tripId,
      kind: 'fromExploreCandidates',
      status: 'pending',
    })

    const trip = await waitFor(async () => {
      const snap = await db.collection('trips').doc(tripId).get()
      const data = snap.data()
      return data?.planMeta?.status === 'error' ? data : undefined
    })

    // No Claude/Places credentials in this emulator — same credential-less
    // failure generatePlan.test.ts's 'full' test asserts, confirming this
    // got past the candidate-loading step and into the real pipeline rather
    // than failing on "no candidates" again.
    expect(trip.planMeta.error).toBeTruthy()
    expect(trip.planMeta.error).not.toContain('No candidate stops')
  })
})

// generateRealPlan's `highlights` param (explore mode's commit step) —
// mocked the same way generatePlan.checkpoint.test.ts mocks planTrip, so
// the "which Claude entry point gets called" and "checkpoints from the two
// paths don't cross-contaminate" behavior is verified deterministically.
const planTripMock = vi.fn()
const generateSkeletonFromHighlightsMock = vi.fn()
vi.mock('./prompts/planTrip.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./prompts/planTrip.js')>()
  return {
    ...actual,
    planTrip: (...args: unknown[]) => planTripMock(...args),
    generateSkeletonFromHighlights: (...args: unknown[]) =>
      generateSkeletonFromHighlightsMock(...args),
  }
})

const resolveSkeletonDaysMock = vi.fn()
vi.mock('./planPipeline.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./planPipeline.js')>()
  return {
    ...actual,
    resolveSkeletonDays: (...args: unknown[]) => resolveSkeletonDaysMock(...args),
  }
})

function fixtureSkeleton(days: number[]) {
  return {
    days: days.map((index) => ({
      index,
      date: `2026-08-0${index + 1}`,
      type: 'drive' as const,
      overnight: { name: `Stop ${index}`, town: `Town ${index}`, country: 'NO' },
      drive: { fromTown: 'prev', toTown: `Stop ${index}`, slot: 'morning' as const },
      summary: `Day ${index} summary`,
      activities: [],
      restaurants: [],
    })),
  }
}

describe('generateRealPlan: highlights param', () => {
  it('calls generateSkeletonFromHighlights, not planTrip, when highlights are supplied', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidRealPlanHighlights')
    const tripRef = db.collection('trips').doc(tripId)
    const trip = (await tripRef.get()).data()

    planTripMock.mockReset()
    generateSkeletonFromHighlightsMock.mockReset().mockResolvedValue(fixtureSkeleton([0]))
    resolveSkeletonDaysMock.mockReset().mockResolvedValue([])

    const { generateRealPlan } = await import('./generatePlan.js')
    await generateRealPlan(trip as never, tripRef, {
      regions: [
        {
          region: 'Test',
          country: 'NO',
          reasoning: 'r',
          candidateStops: [
            { town: 'Otta', country: 'NO', why: 'w', priority: 'must-see' },
          ],
        },
      ],
    })

    expect(generateSkeletonFromHighlightsMock).toHaveBeenCalledTimes(1)
    expect(planTripMock).not.toHaveBeenCalled()
  })

  it('does not resume a highlights-seeded checkpoint from a plain (no-highlights) call at the same settings', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidRealPlanCheckpointIsolation')
    const tripRef = db.collection('trips').doc(tripId)
    const trip = (await tripRef.get()).data()

    planTripMock.mockReset()
    generateSkeletonFromHighlightsMock.mockReset().mockResolvedValue(fixtureSkeleton([0]))
    resolveSkeletonDaysMock.mockReset().mockResolvedValue([])

    const { generateRealPlan } = await import('./generatePlan.js')
    await generateRealPlan(trip as never, tripRef, {
      regions: [
        {
          region: 'Test',
          country: 'NO',
          reasoning: 'r',
          candidateStops: [
            { town: 'Otta', country: 'NO', why: 'w', priority: 'must-see' },
          ],
        },
      ],
    })

    // A plain call right after, same trip/settings — must NOT reuse the
    // highlights-seeded checkpoint just saved, i.e. it still has to call
    // planTrip itself rather than silently resuming the other skeleton.
    planTripMock.mockReset().mockResolvedValue(fixtureSkeleton([0]))
    await generateRealPlan((await tripRef.get()).data() as never, tripRef)

    expect(planTripMock).toHaveBeenCalledTimes(1)
  })
})
