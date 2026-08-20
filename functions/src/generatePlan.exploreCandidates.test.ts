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

// Reported 2026-08-12: two buttons both labelled "Generate full plan" did
// materially different things. Committing from the explore map honoured every
// vote, keep and rejection; the Trip Setup button submitted kind 'full',
// which never looked at corridorStops and re-ran Claude's curation from
// scratch — silently discarding all of it. Both seed from curation now.
describe('generatePlan: full seeds from curation when there is any', () => {
  it('does not demand candidates the way an explore commit does', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidFullNoCandidates')

    await db.collection('planRequests').add({
      tripId,
      kind: 'full',
      status: 'pending',
    })

    const trip = await waitFor(async () => {
      const snap = await db.collection('trips').doc(tripId).get()
      const data = snap.data()
      return data?.planMeta?.status === 'error' ? data : undefined
    })

    // A trip nobody has explored yet is exactly the case 'full' is for:
    // research it from nothing. It must fail on credentials, not on the
    // empty-corridor guard that belongs to the explore path.
    expect(trip.planMeta.error).toBeTruthy()
    expect(trip.planMeta.error).not.toContain('No candidate stops')
  })

  it('reaches the pipeline with curated stops present', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidFullWithCandidates')
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
      kind: 'full',
      status: 'pending',
    })

    const trip = await waitFor(async () => {
      const snap = await db.collection('trips').doc(tripId).get()
      const data = snap.data()
      return data?.planMeta?.status === 'error' ? data : undefined
    })

    expect(trip.planMeta.error).toBeTruthy()
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
            { sight: 'Otta', town: 'Otta', country: 'NO', why: 'w', priority: 'must-see' },
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
            { sight: 'Otta', town: 'Otta', country: 'NO', why: 'w', priority: 'must-see' },
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

/**
 * Reported 2026-08-19: "I'm trying to find ways to not accidentally lose
 * already researched data."
 *
 * The hole: `committed` says "this is in the itinerary", not where the stop
 * came from, and the traveler's own stops end up there too — Lock in, then
 * Add to route. A full regeneration deleted every committed stop and seeded
 * only from candidate/locked, so COMMITTING to a sight made it less likely
 * to appear in the next plan than leaving it in the list would have.
 */
describe('a rebuild and the traveler’s own committed stops', () => {
  // The seed side of the same hole. Preserving the stop is only half a fix:
  // if it is not offered to the plan being written, it survives as a pin
  // nobody proposed and the rebuild simply routes around it.
  it('offers a committed curated stop to the plan replacing it', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidRebuildSeedsCurated')
    const tripRef = db.collection('trips').doc(tripId)
    await tripRef.collection('corridorStops').add({
      name: 'Jotunheimen National Park',
      lat: 61.5,
      lng: 8.3,
      country: 'NO',
      why: 'Marked day hikes from the road.',
      status: 'committed',
      origin: 'traveler',
      linkedDayIds: ['someOldDay'],
      priority: 'must-see',
      region: 'Gudbrandsdalen',
      rank: 0,
    })
    // And one of generation's own, which must NOT seed the rebuild: it
    // describes the route being replaced, and feeding it back would pin the
    // new plan to the old one.
    await tripRef.collection('corridorStops').add({
      name: 'Otta',
      lat: 61.77,
      lng: 9.54,
      country: 'NO',
      status: 'committed',
      origin: 'plan',
      linkedDayIds: ['someOldDay'],
    })

    planTripMock.mockReset()
    generateSkeletonFromHighlightsMock
      .mockReset()
      .mockResolvedValue(fixtureSkeleton([0]))
    resolveSkeletonDaysMock.mockReset().mockResolvedValue([])

    const { runFullGeneration } = await import('./generatePlan.js')
    await runFullGeneration(tripId, 'full', Date.now() + 60_000)

    expect(generateSkeletonFromHighlightsMock).toHaveBeenCalledTimes(1)
    const seeded = generateSkeletonFromHighlightsMock.mock.calls[0][0] as {
      highlights: { regions: { candidateStops: { sight: string }[] }[] }
    }
    const names = seeded.highlights.regions.flatMap((region) =>
      region.candidateStops.map((stop) => stop.sight),
    )
    expect(names).toContain('Jotunheimen National Park')
    expect(names).not.toContain('Otta')
  })

  it('keeps a curated stop that had been added to the route, as locked', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidRebuildKeepsCurated')
    const tripRef = db.collection('trips').doc(tripId)
    const stops = tripRef.collection('corridorStops')
    const curated = await stops.add({
      name: 'Jotunheimen National Park',
      lat: 61.5,
      lng: 8.3,
      country: 'NO',
      why: 'Marked day hikes from the road.',
      status: 'committed',
      origin: 'traveler',
      linkedDayIds: ['someOldDay'],
      priority: 'must-see',
      region: 'Gudbrandsdalen',
      rank: 0,
    })

    const { writeGeneratedDays } = await import('./generatePlan.js')
    await writeGeneratedDays(tripRef, [])

    const after = await curated.get()
    expect(after.exists).toBe(true)
    expect(after.data()?.status).toBe('locked')
    // Its old day links describe a plan that no longer exists.
    expect(after.data()?.linkedDayIds).toEqual([])
    expect(after.data()?.priority).toBe('must-see')
  })

  it('still removes the overnight-town stops generation minted itself', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidRebuildDropsPlanStops')
    const tripRef = db.collection('trips').doc(tripId)
    const minted = await tripRef.collection('corridorStops').add({
      name: 'Otta',
      lat: 61.77,
      lng: 9.54,
      country: 'NO',
      why: 'Gateway to the park.',
      status: 'committed',
      origin: 'plan',
      linkedDayIds: ['someOldDay'],
    })

    const { writeGeneratedDays } = await import('./generatePlan.js')
    await writeGeneratedDays(tripRef, [])

    expect((await minted.get()).exists).toBe(false)
  })

  // Everything written before `origin` existed carries none, and this gates a
  // deletion — so the conservative reading keeps old trips behaving exactly
  // as they did rather than resurrecting stops nobody asked to keep.
  it('treats a stop with no recorded origin the way it always did', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidRebuildLegacyStop')
    const tripRef = db.collection('trips').doc(tripId)
    const legacy = await tripRef.collection('corridorStops').add({
      name: 'Lillehammer',
      lat: 61.11,
      lng: 10.46,
      country: 'NO',
      status: 'committed',
      linkedDayIds: ['someOldDay'],
    })

    const { writeGeneratedDays } = await import('./generatePlan.js')
    await writeGeneratedDays(tripRef, [])

    expect((await legacy.get()).exists).toBe(false)
  })
})
