import { getFirestore } from 'firebase-admin/firestore'
import { initializeApp } from 'firebase-admin/app'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTripForUser } from './trips.js'
import type { TripDay } from '@rv/shared'

const PROJECT_ID = 'demo-rv-trip-planner'

beforeAll(() => {
  initializeApp({ projectId: PROJECT_ID })
  getFirestore().settings({ ignoreUndefinedProperties: true })
})

// The Claude call and the Places enrichment are mocked; what these tests are
// for is the orchestration around them — which days get claimed, what is
// written, and what happens when it fails — against the real emulator.
const generateChunkDetailMock = vi.fn()
vi.mock('./prompts/planTrip.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./prompts/planTrip.js')>()
  return {
    ...actual,
    generateChunkDetail: (...args: unknown[]) => generateChunkDetailMock(...args),
  }
})

const enrichDayDetailMock = vi.fn()
vi.mock('./dayDetail.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./dayDetail.js')>()
  return {
    ...actual,
    enrichDayDetail: (...args: unknown[]) => enrichDayDetailMock(...args),
  }
})

function detailFor(indexes: number[]) {
  return {
    days: indexes.map((index) => ({
      index,
      summary: `Real summary for day ${index}`,
      activities: [],
      restaurants: [],
    })),
  }
}

async function tripWithDays(
  uid: string,
  count: number,
  // null means "write no detailStatus at all" — the legacy shape. Not
  // `undefined`, which a default parameter would silently turn back into
  // 'pending' and quietly stop testing anything.
  detailStatus: TripDay['detailStatus'] | null = 'pending',
): Promise<{ tripId: string; dayIds: string[] }> {
  const { tripId } = await createTripForUser(uid)
  const tripRef = getFirestore().collection('trips').doc(tripId)
  await tripRef.update({ 'planMeta.status': 'ready' })
  const dayIds: string[] = []
  for (let index = 0; index < count; index++) {
    const ref = tripRef.collection('days').doc()
    const day: TripDay = {
      index,
      date: `2026-07-${String(10 + index).padStart(2, '0')}`,
      type: 'drive',
      overnight: { name: `Town ${index}`, lat: 59 + index, lng: 10, country: 'NO' },
      townAnchor: { lat: 59 + index, lng: 10 },
      summary: `Outline sentence for day ${index}`,
      highlightReason: `Day ${index} is for the thing in Town ${index}.`,
      ...(detailStatus ? { detailStatus } : {}),
    }
    await ref.set(day)
    dayIds.push(ref.id)
  }
  return { tripId, dayIds }
}

beforeEach(() => {
  enrichDayDetailMock
    .mockReset()
    .mockResolvedValue({ activities: [], restaurants: [] })
  generateChunkDetailMock.mockReset()
})

/**
 * The lazy half of "route eagerly, detail lazily": the route for every day
 * already exists, and this fills in what a day is actually made of, for the
 * day being opened and the couple after it.
 */
describe('runDetailDays', () => {
  it('details the opened day and the two after it, and no further', async () => {
    const { tripId, dayIds } = await tripWithDays('uidDetailA', 6)
    generateChunkDetailMock.mockResolvedValue(detailFor([0, 1, 2]))

    const { runDetailDays } = await import('./detailDaysCallable.js')
    const result = await runDetailDays(tripId, dayIds[0], 3)

    expect(result.detailed).toBe(3)
    const snap = await getFirestore()
      .collection('trips')
      .doc(tripId)
      .collection('days')
      .orderBy('index')
      .get()
    const statuses = snap.docs.map((doc) => (doc.data() as TripDay).detailStatus)
    expect(statuses).toEqual([
      'ready',
      'ready',
      'ready',
      'pending',
      'pending',
      'pending',
    ])
  })

  // The real summary replaces the outline sentence that stood in for it.
  it("replaces the placeholder summary with the day's real one", async () => {
    const { tripId, dayIds } = await tripWithDays('uidDetailB', 1)
    generateChunkDetailMock.mockResolvedValue(detailFor([0]))

    const { runDetailDays } = await import('./detailDaysCallable.js')
    await runDetailDays(tripId, dayIds[0], 3)

    const doc = await getFirestore()
      .collection('trips')
      .doc(tripId)
      .collection('days')
      .doc(dayIds[0])
      .get()
    expect((doc.data() as TripDay).summary).toBe('Real summary for day 0')
  })

  // The route is not this run's to touch — it writes into the day, not over
  // it.
  it('leaves the route fields alone', async () => {
    const { tripId, dayIds } = await tripWithDays('uidDetailC', 1)
    generateChunkDetailMock.mockResolvedValue(detailFor([0]))

    const { runDetailDays } = await import('./detailDaysCallable.js')
    await runDetailDays(tripId, dayIds[0], 3)

    const day = (
      await getFirestore()
        .collection('trips')
        .doc(tripId)
        .collection('days')
        .doc(dayIds[0])
        .get()
    ).data() as TripDay
    expect(day.overnight.name).toBe('Town 0')
    expect(day.date).toBe('2026-07-10')
    expect(day.highlightReason).toBe('Day 0 is for the thing in Town 0.')
  })

  // Opening day 4 right after day 3 must cost one day, not three.
  it('skips days that are already detailed instead of paying for them again', async () => {
    const { tripId, dayIds } = await tripWithDays('uidDetailD', 3)
    const tripRef = getFirestore().collection('trips').doc(tripId)
    await tripRef.collection('days').doc(dayIds[0]).update({ detailStatus: 'ready' })
    await tripRef.collection('days').doc(dayIds[1]).update({ detailStatus: 'ready' })
    generateChunkDetailMock.mockResolvedValue(detailFor([2]))

    const { runDetailDays } = await import('./detailDaysCallable.js')
    const result = await runDetailDays(tripId, dayIds[0], 3)

    expect(result.detailed).toBe(1)
    const [call] = generateChunkDetailMock.mock.calls
    const input = call[1] as { chunkDays: { index: number }[] }
    expect(input.chunkDays.map((day) => day.index)).toEqual([2])
  })

  it('costs nothing at all when the whole window is ready', async () => {
    const { tripId, dayIds } = await tripWithDays('uidDetailE', 3, 'ready')

    const { runDetailDays } = await import('./detailDaysCallable.js')
    const result = await runDetailDays(tripId, dayIds[0], 3)

    expect(result).toEqual({ detailed: 0, alreadyReady: 3 })
    expect(generateChunkDetailMock).not.toHaveBeenCalled()
  })

  // Absent means ready — every day written before detailStatus existed
  // carries its detail already, and must not be re-detailed as though it
  // were an empty day.
  it('treats a day with no detailStatus at all as already done', async () => {
    const { tripId, dayIds } = await tripWithDays('uidDetailF', 2, null)

    const { runDetailDays } = await import('./detailDaysCallable.js')
    const result = await runDetailDays(tripId, dayIds[0], 3)

    expect(result.detailed).toBe(0)
    expect(generateChunkDetailMock).not.toHaveBeenCalled()
  })

  // Claude is given the whole route as context, not just the window — it is
  // what stops day 9's dinner being chosen as though days 8 and 10 did not
  // exist.
  it('gives Claude the whole route as context, and the window to work on', async () => {
    const { tripId, dayIds } = await tripWithDays('uidDetailG', 5)
    generateChunkDetailMock.mockResolvedValue(detailFor([1, 2, 3]))

    const { runDetailDays } = await import('./detailDaysCallable.js')
    await runDetailDays(tripId, dayIds[1], 3)

    const input = generateChunkDetailMock.mock.calls[0][1] as {
      outline: { days: { index: number }[] }
      chunkDays: { index: number }[]
    }
    expect(input.outline.days.map((day) => day.index)).toEqual([0, 1, 2, 3, 4])
    expect(input.chunkDays.map((day) => day.index)).toEqual([1, 2, 3])
  })

  // A day left 'generating' by a failed run is a spinner forever, and a
  // failure with no reason attached is what made three rescan failures in a
  // row undiagnosable.
  it('puts a failed day back to pending, with the reason on the day', async () => {
    const { tripId, dayIds } = await tripWithDays('uidDetailH', 2)
    generateChunkDetailMock.mockRejectedValue(new Error('529 overloaded_error'))

    const { runDetailDays } = await import('./detailDaysCallable.js')
    await expect(runDetailDays(tripId, dayIds[0], 3)).rejects.toThrow(
      /Could not plan those days.*overloaded/i,
    )

    const day = (
      await getFirestore()
        .collection('trips')
        .doc(tripId)
        .collection('days')
        .doc(dayIds[0])
        .get()
    ).data() as TripDay
    expect(day.detailStatus).toBe('pending')
    expect(day.detailError).toMatch(/overloaded/i)
  })

  it('clears a previous failure once the day is detailed', async () => {
    const { tripId, dayIds } = await tripWithDays('uidDetailI', 1)
    await getFirestore()
      .collection('trips')
      .doc(tripId)
      .collection('days')
      .doc(dayIds[0])
      .update({ detailError: 'Something went wrong last time.' })
    generateChunkDetailMock.mockResolvedValue(detailFor([0]))

    const { runDetailDays } = await import('./detailDaysCallable.js')
    await runDetailDays(tripId, dayIds[0], 3)

    const day = (
      await getFirestore()
        .collection('trips')
        .doc(tripId)
        .collection('days')
        .doc(dayIds[0])
        .get()
    ).data() as TripDay
    expect(day.detailError).toBeUndefined()
  })

  // Two devices opening overlapping windows must not both pay for the same
  // day — the claim is per day and transactional.
  it('never details the same day twice when two requests overlap', async () => {
    const { tripId, dayIds } = await tripWithDays('uidDetailJ', 4)
    generateChunkDetailMock.mockImplementation(
      (_client: unknown, input: { chunkDays: { index: number }[] }) =>
        Promise.resolve(detailFor(input.chunkDays.map((day) => day.index))),
    )

    const { runDetailDays } = await import('./detailDaysCallable.js')
    const [first, second] = await Promise.all([
      runDetailDays(tripId, dayIds[0], 3),
      runDetailDays(tripId, dayIds[1], 3),
    ])

    // Four days, each claimed exactly once between the two runs.
    expect(first.detailed + second.detailed).toBe(4)
    const detailed = generateChunkDetailMock.mock.calls.flatMap(
      (call) => (call[1] as { chunkDays: { index: number }[] }).chunkDays,
    )
    expect(new Set(detailed.map((day) => day.index)).size).toBe(detailed.length)
  })

  it('refuses a day that is not on this trip', async () => {
    const { tripId } = await tripWithDays('uidDetailK', 1)

    const { runDetailDays } = await import('./detailDaysCallable.js')
    await expect(runDetailDays(tripId, 'not-a-day', 3)).rejects.toThrow(
      /Day not found/i,
    )
  })
})
