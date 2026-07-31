import { getFirestore } from 'firebase-admin/firestore'
import { initializeApp } from 'firebase-admin/app'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createTripForUser } from './trips.js'
import type { Trip } from '@rv/shared'

const PROJECT_ID = 'demo-rv-trip-planner'

beforeAll(() => {
  initializeApp({ projectId: PROJECT_ID })
  getFirestore().settings({ ignoreUndefinedProperties: true })
})

// generateRealPlan's checkpointing (implemented 2026-07-27) drives planTrip
// + resolveSkeletonDays the same way replanTrip.test.ts's runReplan tests
// do — mocked at the module level so the resume-vs-start-clean orchestration
// is verified deterministically against the real Firestore emulator,
// without needing real Claude/Places credentials.
const planTripMock = vi.fn()
vi.mock('./prompts/planTrip.js', async (importOriginal) => {
  // Unlike replanTrip.ts, generatePlan.ts also imports claudeApiKey from
  // this module (for the Cloud Function's `secrets` declaration) — importOriginal
  // preserves that export instead of leaving it undefined.
  const actual = await importOriginal<typeof import('./prompts/planTrip.js')>()
  return {
    ...actual,
    planTrip: (...args: unknown[]) => planTripMock(...args),
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

// checkpoint.skeleton round-trips through Firestore and is re-validated
// against planTripSkeletonSchema on read (see planCheckpoint.ts's
// loadCheckpoint) — unlike replanTrip.test.ts's minimal `{index}` fixture
// days (which flow only through the also-mocked resolveSkeletonDays and are
// never schema-checked), this fixture must be a fully valid skeleton day.
function fixtureSkeletonDay(index: number) {
  return {
    index,
    date: `2026-08-0${index + 1}`,
    type: 'drive' as const,
    overnight: { name: `Stop ${index}`, town: `Town ${index}`, country: 'NO' },
    drive: { fromTown: 'prev', toTown: `Stop ${index}`, slot: 'morning' as const },
    summary: `Day ${index} summary`,
    activities: Array.from({ length: 5 }, (_, i) => ({
      name: `Activity ${index}-${i}`,
      town: `Town ${index}`,
      category: 'sight' as const,
      kidFriendly: false,
      blurb: 'A fixture activity.',
    })),
    restaurants: (['breakfast', 'lunch', 'dinner'] as const).flatMap((meal) =>
      Array.from({ length: 3 }, (_, i) => ({
        name: `${meal} ${index}-${i}`,
        town: `Town ${index}`,
        meal,
        blurb: 'A fixture restaurant.',
      })),
    ),
  }
}

function fixtureGeneratedDay(index: number, date: string) {
  return {
    day: {
      index,
      date,
      type: 'drive' as const,
      overnight: {
        name: `Stop ${index}`,
        lat: 61 + index,
        lng: 9 + index,
        country: 'NO',
      },
      drive: {
        fromName: 'prev',
        toName: `Stop ${index}`,
        distanceKm: 100,
        durationMin: 90,
        slot: 'morning' as const,
      },
      summary: `Day ${index}`,
    },
    activities: [],
    restaurants: [],
  }
}

async function loadTrip(tripId: string): Promise<Trip> {
  const snap = await getFirestore().collection('trips').doc(tripId).get()
  return snap.data() as Trip
}

describe('generateRealPlan checkpointing', () => {
  it('stages days as they resolve, and a retry after a mid-pipeline failure reuses the skeleton and staged days', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidCkptA')
    const tripRef = db.collection('trips').doc(tripId)

    planTripMock.mockReset().mockResolvedValue({
      days: [
        fixtureSkeletonDay(0),
        fixtureSkeletonDay(1),
        fixtureSkeletonDay(2),
      ],
    })

    resolveSkeletonDaysMock.mockReset().mockImplementationOnce(
      async (
        skeletonDays: { index: number }[],
        _startLocation: unknown,
        onDayResolved?: (count: number) => void,
        onDayGenerated?: (index: number, day: unknown) => void | Promise<void>,
      ) => {
        // Simulate resolving only the first of 3 days before a crash — the
        // Places/Routes lookups are the slow, sequential part a real
        // failure (rate limit, timeout) would plausibly interrupt partway
        // through.
        await onDayGenerated?.(
          skeletonDays[0].index,
          fixtureGeneratedDay(skeletonDays[0].index, '2026-08-01'),
        )
        onDayResolved?.(1)
        throw new Error('simulated Places API failure')
      },
    )

    const { generateRealPlan } = await import('./generatePlan.js')
    const trip = await loadTrip(tripId)
    await expect(generateRealPlan(trip, tripRef)).rejects.toThrow(
      'simulated Places API failure',
    )

    expect(planTripMock).toHaveBeenCalledTimes(1)

    const afterFailure = await tripRef.get()
    expect(afterFailure.data()?.planMeta.checkpoint?.skeleton).toBeDefined()
    const stagedAfterFailure = await tripRef
      .collection('generationStaging')
      .get()
    expect(stagedAfterFailure.size).toBe(1)

    // Retry: only the 2 remaining days should be asked for, starting from
    // the staged day's location (not trip.settings.startPoint), and
    // planTrip must not run again — the whole point of the checkpoint.
    resolveSkeletonDaysMock.mockReset().mockImplementationOnce(
      async (
        skeletonDays: { index: number }[],
        startLocation: { name: string },
        onDayResolved?: (count: number) => void,
        onDayGenerated?: (index: number, day: unknown) => void | Promise<void>,
      ) => {
        expect(skeletonDays.map((d) => d.index)).toEqual([1, 2])
        expect(startLocation.name).toBe('Stop 0')
        const result = skeletonDays.map((d) =>
          fixtureGeneratedDay(d.index, `2026-08-0${d.index + 1}`),
        )
        for (const [i, day] of result.entries()) {
          await onDayGenerated?.(skeletonDays[i].index, day)
        }
        onDayResolved?.(result.length)
        return result
      },
    )

    const tripAfterFailure = await loadTrip(tripId)
    const { days, complete } = await generateRealPlan(tripAfterFailure, tripRef)

    expect(planTripMock).toHaveBeenCalledTimes(1) // still just once
    expect(days.map((d) => d.day.index)).toEqual([0, 1, 2])
    expect(complete).toBe(true)
  })

  it('discards the checkpoint and starts clean if settings changed since the failed attempt', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidCkptB')
    const tripRef = db.collection('trips').doc(tripId)

    planTripMock.mockReset().mockResolvedValue({ days: [fixtureSkeletonDay(0)] })
    resolveSkeletonDaysMock.mockReset().mockImplementationOnce(
      async (
        _skeletonDays: unknown,
        _startLocation: unknown,
        _onDayResolved: unknown,
        onDayGenerated?: (index: number, day: unknown) => void | Promise<void>,
      ) => {
        await onDayGenerated?.(0, fixtureGeneratedDay(0, '2026-08-01'))
        throw new Error('simulated failure')
      },
    )

    const { generateRealPlan } = await import('./generatePlan.js')
    const trip = await loadTrip(tripId)
    await expect(generateRealPlan(trip, tripRef)).rejects.toThrow()
    expect(planTripMock).toHaveBeenCalledTimes(1)

    // The traveler edits settings before retrying.
    await tripRef.update({ 'settings.maxDriveHoursPerDay': 6 })
    const changedTrip = await loadTrip(tripId)

    resolveSkeletonDaysMock.mockReset().mockImplementationOnce(
      async (
        skeletonDays: { index: number }[],
        _startLocation: unknown,
        onDayResolved?: (count: number) => void,
        onDayGenerated?: (index: number, day: unknown) => void | Promise<void>,
      ) => {
        const result = skeletonDays.map((d) =>
          fixtureGeneratedDay(d.index, '2026-08-01'),
        )
        for (const [i, day] of result.entries()) {
          await onDayGenerated?.(skeletonDays[i].index, day)
        }
        onDayResolved?.(result.length)
        return result
      },
    )

    await generateRealPlan(changedTrip, tripRef)

    // planTrip WAS called again — the stale checkpoint wasn't reused.
    expect(planTripMock).toHaveBeenCalledTimes(2)
    const staged = await tripRef.collection('generationStaging').get()
    // Only the fresh attempt's 1 day, not the old attempt's plus the new one.
    expect(staged.size).toBe(1)
  })
})

// Segmented generation (2026-07-31): generateRealPlan reports `complete:
// false` when resolveSkeletonDays returns fewer days than the skeleton asked
// for (a real caller only does this when it hit its own deadline — see
// resolveSkeletonDays' own deadline tests in planPipeline.test.ts — but
// generateRealPlan only needs to react to the count, not know why it's
// short), and runFullGeneration reacts to that by chaining a continuation
// planRequest instead of finalizing the trip.
describe('generateRealPlan / runFullGeneration — incomplete (deadline-cut) generation', () => {
  it('generateRealPlan reports complete: false when resolveSkeletonDays returns short of the full skeleton', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidCkptIncomplete')
    const tripRef = db.collection('trips').doc(tripId)

    planTripMock.mockReset().mockResolvedValue({
      days: [fixtureSkeletonDay(0), fixtureSkeletonDay(1), fixtureSkeletonDay(2)],
    })
    resolveSkeletonDaysMock.mockReset().mockImplementationOnce(
      async (
        skeletonDays: { index: number }[],
        _startLocation: unknown,
        onDayResolved?: (count: number) => void,
        onDayGenerated?: (index: number, day: unknown) => void | Promise<void>,
      ) => {
        // Simulates hitting a deadline after only the first of 3 days —
        // resolves and stages it normally, then just stops (no throw,
        // unlike the crash-recovery tests above).
        const day = fixtureGeneratedDay(skeletonDays[0].index, '2026-08-01')
        await onDayGenerated?.(skeletonDays[0].index, day)
        onDayResolved?.(1)
        return [day]
      },
    )

    const { generateRealPlan } = await import('./generatePlan.js')
    const trip = await loadTrip(tripId)
    const { days, complete } = await generateRealPlan(trip, tripRef)

    expect(complete).toBe(false)
    expect(days).toHaveLength(1)
    // Still durably staged for a future resume, exactly like the
    // crash-recovery case — an incomplete run must leave the checkpoint
    // intact, not clear it.
    const staged = await tripRef.collection('generationStaging').get()
    expect(staged.size).toBe(1)
  })

  it('runFullGeneration chains a continuation planRequest and leaves the trip generating, rather than finalizing a partial plan', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidFullGenIncomplete')

    planTripMock.mockReset().mockResolvedValue({
      days: [fixtureSkeletonDay(0), fixtureSkeletonDay(1), fixtureSkeletonDay(2)],
    })
    resolveSkeletonDaysMock.mockReset().mockImplementationOnce(
      async (
        skeletonDays: { index: number }[],
        _startLocation: unknown,
        onDayResolved?: (count: number) => void,
        onDayGenerated?: (index: number, day: unknown) => void | Promise<void>,
      ) => {
        const day = fixtureGeneratedDay(skeletonDays[0].index, '2026-08-01')
        await onDayGenerated?.(skeletonDays[0].index, day)
        onDayResolved?.(1)
        return [day]
      },
    )

    const { runFullGeneration } = await import('./generatePlan.js')
    const result = await runFullGeneration(tripId, 'full', Date.now() + 60_000)

    expect(result).toEqual({ chained: true })

    const trip = await loadTrip(tripId)
    // Still mid-generation, not finalized off an incomplete day set — and
    // the checkpoint (needed for the continuation to resume) is intact.
    expect(trip.planMeta.status).toBe('generating')
    expect(trip.planMeta.checkpoint?.skeleton).toBeDefined()

    const continuationSnap = await db
      .collection('planRequests')
      .where('tripId', '==', tripId)
      .where('isContinuation', '==', true)
      .get()
    expect(continuationSnap.size).toBe(1)
    expect(continuationSnap.docs[0].data()).toMatchObject({
      tripId,
      kind: 'full',
      status: 'pending',
      isContinuation: true,
    })
  })

  it('runFullGeneration finalizes normally (no continuation, status ready) when resolveSkeletonDays returns every day', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidFullGenComplete')

    planTripMock.mockReset().mockResolvedValue({ days: [fixtureSkeletonDay(0)] })
    resolveSkeletonDaysMock.mockReset().mockImplementationOnce(
      async (
        skeletonDays: { index: number }[],
        _startLocation: unknown,
        onDayResolved?: (count: number) => void,
        onDayGenerated?: (index: number, day: unknown) => void | Promise<void>,
      ) => {
        const day = fixtureGeneratedDay(skeletonDays[0].index, '2026-08-01')
        await onDayGenerated?.(skeletonDays[0].index, day)
        onDayResolved?.(1)
        return [day]
      },
    )

    const { runFullGeneration } = await import('./generatePlan.js')
    const result = await runFullGeneration(tripId, 'full', Date.now() + 60_000)

    expect(result).toEqual({ chained: false })

    const trip = await loadTrip(tripId)
    expect(trip.planMeta.status).toBe('ready')
    expect(trip.planMeta.checkpoint).toBeUndefined()

    const continuationSnap = await db
      .collection('planRequests')
      .where('tripId', '==', tripId)
      .where('isContinuation', '==', true)
      .get()
    expect(continuationSnap.size).toBe(0)
  })
})
