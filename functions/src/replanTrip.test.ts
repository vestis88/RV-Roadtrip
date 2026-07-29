import { getFirestore, type DocumentReference } from 'firebase-admin/firestore'
import { initializeApp } from 'firebase-admin/app'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createTripForUser } from './trips.js'
import { validatePacing } from './pacingValidator.js'
import type { CorridorStop, TripDay } from '@rv/shared'

const PROJECT_ID = 'demo-rv-trip-planner'

beforeAll(() => {
  initializeApp({ projectId: PROJECT_ID })
  getFirestore().settings({ ignoreUndefinedProperties: true })
})

// runReplan now drives the real planTrip + resolveSkeletonDays pipeline
// (Claude + Places/Routes), same as a fresh generation — these tests mock
// both at the module level (same approach planTrip.test.ts and
// placesApi.test.ts already use for their own dependencies) so replanTrip's
// own orchestration logic — reindexing, preserving past/locked days,
// generate-before-delete ordering, pacing — is verified deterministically
// against the real Firestore emulator, without needing real credentials.
const planTripMock = vi.fn()
vi.mock('./prompts/planTrip.js', () => ({
  planTrip: (...args: unknown[]) => planTripMock(...args),
}))

const resolveSkeletonDaysMock = vi.fn()
vi.mock('./planPipeline.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./planPipeline.js')>()
  return {
    ...actual,
    resolveSkeletonDays: (...args: unknown[]) => resolveSkeletonDaysMock(...args),
  }
})

/** A day replanTrip rewrites (an unlocked future day) gets a fresh
 * auto-generated ID — look it up by its `date` field, not by the date string
 * it might have coincidentally had before the replan. */
async function dayByDate(tripRef: DocumentReference, date: string) {
  const snap = await tripRef
    .collection('days')
    .where('date', '==', date)
    .limit(1)
    .get()
  if (snap.empty) throw new Error(`No day found for date ${date}`)
  return snap.docs[0]
}

function placeholderActivity(lat: number, lng: number) {
  return {
    name: 'placeholder',
    category: 'sight',
    lat,
    lng,
    blurb: 'placeholder',
    kidFriendly: true,
    status: 'suggested',
  }
}

// A fixture GeneratedDay standing in for a real resolveSkeletonDay() result.
function fixtureGeneratedDay(index: number, date: string, summary: string) {
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
        fromName: 'Current location',
        toName: `Stop ${index}`,
        distanceKm: 100,
        durationMin: 90,
        slot: 'morning' as const,
      },
      summary,
    },
    activities: [],
    restaurants: [],
  }
}

describe('replanTrip', () => {
  it('regenerates the remainder via the real pipeline, leaves past days untouched, and keeps the plan well-paced', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidA')
    const tripRef = db.collection('trips').doc(tripId)

    const pastDay1: TripDay = {
      index: 0,
      date: '2026-07-10',
      type: 'drive',
      overnight: { name: 'Lillehammer', lat: 61.1, lng: 10.5, country: 'NO' },
      drive: {
        fromName: 'Oslo',
        toName: 'Lillehammer',
        distanceKm: 180,
        durationMin: 150,
        slot: 'morning',
      },
      summary: 'ORIGINAL day 1',
    }
    const pastDay2: TripDay = {
      index: 1,
      date: '2026-07-11',
      type: 'drive',
      overnight: { name: 'Otta', lat: 61.77, lng: 9.54, country: 'NO' },
      drive: {
        fromName: 'Lillehammer',
        toName: 'Otta',
        distanceKm: 140,
        durationMin: 120,
        slot: 'midday',
      },
      summary: 'ORIGINAL day 2',
    }
    const staleFutureDay: TripDay = {
      index: 2,
      date: '2026-07-12',
      type: 'drive',
      overnight: { name: 'Dombas', lat: 62.07, lng: 9.13, country: 'NO' },
      drive: {
        fromName: 'Otta',
        toName: 'Dombas',
        distanceKm: 50,
        durationMin: 45,
        slot: 'morning',
      },
      summary: 'STALE — should be replaced by replan',
    }

    for (const day of [pastDay1, pastDay2, staleFutureDay]) {
      const dayRef = tripRef.collection('days').doc(day.date)
      await dayRef.set(day)
      await dayRef.collection('activities').add(placeholderActivity(day.overnight.lat, day.overnight.lng))
    }
    await tripRef.update({ 'planMeta.status': 'ready' })

    planTripMock.mockReset().mockResolvedValue({
      days: [{ index: 0 }, { index: 1 }],
    })
    resolveSkeletonDaysMock.mockReset().mockImplementation(
      async (
        skeletonDays: { index: number }[],
        _startLocation: unknown,
        onDayResolved?: (count: number) => void,
      ) => {
        const dates = ['2026-07-12', '2026-07-13']
        const result = skeletonDays.map((d, i) =>
          fixtureGeneratedDay(d.index, dates[i], `REPLANNED day ${d.index}`),
        )
        onDayResolved?.(result.length)
        return result
      },
    )

    const { runReplan } = await import('./replanTrip.js')
    await runReplan(tripId, {
      currentLocation: { lat: 61.77, lng: 9.54 },
      today: '2026-07-12',
      completedRefPaths: [],
      remainingEndDate: '2026-07-13',
      remainingEndPoint: { name: 'Dombas', lat: 62.07, lng: 9.13 },
    })

    const tripSnap = await tripRef.get()
    const trip = tripSnap.data()
    expect(trip?.planMeta.status).toBe('ready')
    expect(trip?.planMeta.lastReplanAt).toBeDefined()

    // Past days: untouched.
    const day1Snap = await tripRef.collection('days').doc('2026-07-10').get()
    const day2Snap = await tripRef.collection('days').doc('2026-07-11').get()
    expect(day1Snap.data()?.summary).toBe('ORIGINAL day 1')
    expect(day2Snap.data()?.summary).toBe('ORIGINAL day 2')

    // Stale future day: replaced, not left in place, and reindexed to
    // continue from pastDocs.length (2) rather than the skeleton's own 0.
    const staleSnap = await dayByDate(tripRef, '2026-07-12')
    expect(staleSnap.data()?.summary).toBe('REPLANNED day 2')
    expect(staleSnap.data()?.index).toBe(2)

    // New remainder day at the requested end date exists, also reindexed.
    const finalDaySnap = await dayByDate(tripRef, '2026-07-13')
    expect(finalDaySnap.data()?.summary).toBe('REPLANNED day 3')
    expect(finalDaySnap.data()?.index).toBe(3)

    // planTrip was actually invoked, scoped to the remainder only.
    expect(planTripMock).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({
          startDate: '2026-07-12',
          endDate: '2026-07-13',
          endPoint: { name: 'Dombas', lat: 62.07, lng: 9.13 },
        }),
      }),
    )

    // The regenerated remainder (past days are historical fact and aren't
    // re-paced) respects the pacing rules.
    const remainderDays = [staleSnap.data() as TripDay, finalDaySnap.data() as TripDay]
    expect(validatePacing(remainderDays, 4)).toBeNull()
  })

  it('preserves locked days from the "Request changes" flow, even when they fall in the future', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidB')
    const tripRef = db.collection('trips').doc(tripId)

    const pastDay: TripDay = {
      index: 0,
      date: '2026-07-10',
      type: 'drive',
      overnight: { name: 'Lillehammer', lat: 61.1, lng: 10.5, country: 'NO' },
      drive: {
        fromName: 'Oslo',
        toName: 'Lillehammer',
        distanceKm: 180,
        durationMin: 150,
        slot: 'morning',
      },
      summary: 'ORIGINAL day 1',
    }
    const staleFutureDay: TripDay = {
      index: 1,
      date: '2026-07-12',
      type: 'drive',
      overnight: { name: 'Otta', lat: 61.77, lng: 9.54, country: 'NO' },
      drive: {
        fromName: 'Lillehammer',
        toName: 'Otta',
        distanceKm: 140,
        durationMin: 120,
        slot: 'morning',
      },
      summary: 'STALE — should be replaced by replan',
    }
    // Locked day sits strictly BETWEEN today and remainingEndDate — the
    // "Request changes" UI allows locking any day, not just boundary ones.
    const lockedMidRangeDay: TripDay = {
      index: 2,
      date: '2026-07-13',
      type: 'rest',
      overnight: { name: 'Otta', lat: 61.77, lng: 9.54, country: 'NO' },
      summary: 'LOCKED — should survive replan untouched',
    }

    for (const day of [pastDay, staleFutureDay, lockedMidRangeDay]) {
      const dayRef = tripRef.collection('days').doc(day.date)
      await dayRef.set(day)
      await dayRef.collection('activities').add(placeholderActivity(day.overnight.lat, day.overnight.lng))
    }
    await tripRef.update({ 'planMeta.status': 'ready' })

    // The mocked skeleton spans the FULL today..remainingEndDate range
    // (2026-07-12, 13, 14) — exactly like a real planTrip() call would,
    // with no awareness that 07-13 is already locked. This is what proves
    // the collision-safety filter: day 3 (07-13) must be dropped rather
    // than overwriting the locked day, while days 2 and 4 still land.
    planTripMock.mockReset().mockResolvedValue({
      days: [{ index: 0 }, { index: 1 }, { index: 2 }],
    })
    resolveSkeletonDaysMock.mockReset().mockImplementation(
      async (
        skeletonDays: { index: number }[],
        _startLocation: unknown,
        onDayResolved?: (count: number) => void,
      ) => {
        const dates = ['2026-07-12', '2026-07-13', '2026-07-14']
        const result = skeletonDays.map((d, i) =>
          fixtureGeneratedDay(d.index, dates[i], `REPLANNED day ${d.index}`),
        )
        onDayResolved?.(result.length)
        return result
      },
    )

    const { runReplan } = await import('./replanTrip.js')
    await runReplan(tripId, {
      currentLocation: { lat: 61.1, lng: 10.5 },
      today: '2026-07-12',
      completedRefPaths: [],
      remainingEndDate: '2026-07-14',
      remainingEndPoint: { name: 'Dombas', lat: 62.07, lng: 9.13 },
      changeRequestText: 'more beaches, skip big cities',
      lockedDayIds: ['2026-07-13'],
    })

    const tripSnap = await tripRef.get()
    expect(tripSnap.data()?.planMeta.lastReplanAt).toBeDefined()

    // Locked day: untouched, even though it's in the future AND the
    // generated remainder proposed a colliding day for that same date.
    const lockedSnap = await tripRef.collection('days').doc('2026-07-13').get()
    expect(lockedSnap.data()?.summary).toBe(
      'LOCKED — should survive replan untouched',
    )
    const lockedActivities = await lockedSnap.ref.collection('activities').get()
    expect(lockedActivities.size).toBe(1)

    // Stale, unlocked future day: still replaced as normal. pastDocs is
    // [pastDay, lockedMidRangeDay] (locked counts as "preserved" regardless
    // of date), so reindexing starts at 2 — this is skeleton position 0.
    const staleSnap = await dayByDate(tripRef, '2026-07-12')
    expect(staleSnap.data()?.summary).toBe('REPLANNED day 2')

    // The day after the locked one still gets written normally, at
    // skeleton position 2 → reindexed to 4.
    const afterLockedSnap = await dayByDate(tripRef, '2026-07-14')
    expect(afterLockedSnap.data()?.summary).toBe('REPLANNED day 4')

    // planTrip received the change request text folded into the notes.
    expect(planTripMock).toHaveBeenCalledWith(
      expect.objectContaining({
        notesFreeText: expect.stringContaining('more beaches, skip big cities'),
      }),
    )
  })

  it('leaves the trip untouched if planTrip fails, rather than deleting future days with nothing to replace them', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidC')
    const tripRef = db.collection('trips').doc(tripId)

    const futureDay: TripDay = {
      index: 0,
      date: '2026-07-12',
      type: 'drive',
      overnight: { name: 'Otta', lat: 61.77, lng: 9.54, country: 'NO' },
      drive: {
        fromName: 'Lillehammer',
        toName: 'Otta',
        distanceKm: 140,
        durationMin: 120,
        slot: 'morning',
      },
      summary: 'ORIGINAL — must survive a failed replan',
    }
    const dayRef = tripRef.collection('days').doc(futureDay.date)
    await dayRef.set(futureDay)
    await tripRef.update({ 'planMeta.status': 'ready' })

    planTripMock.mockReset().mockRejectedValue(new Error('Claude API unavailable'))
    resolveSkeletonDaysMock.mockReset()

    const { runReplan } = await import('./replanTrip.js')
    await expect(
      runReplan(tripId, {
        currentLocation: { lat: 61.77, lng: 9.54 },
        today: '2026-07-12',
        completedRefPaths: [],
        remainingEndDate: '2026-07-12',
        remainingEndPoint: { name: 'Dombas', lat: 62.07, lng: 9.13 },
      }),
    ).rejects.toThrow('Claude API unavailable')

    const survivingSnap = await dayRef.get()
    expect(survivingSnap.exists).toBe(true)
    expect(survivingSnap.data()?.summary).toBe(
      'ORIGINAL — must survive a failed replan',
    )
    expect(resolveSkeletonDaysMock).not.toHaveBeenCalled()
  })

  // Bug fix, reported 2026-07-27: a behind-schedule replan's outline used to
  // get no signal distinguishing it from a normal remainder, so the pacing
  // rule's flat "remaining distance / remaining days" target — now higher,
  // since falling behind doesn't shrink the remaining distance but does
  // shrink the remaining days — could make day 1 of the "fix" suggest an
  // even longer drive than before.
  it('asks for an easy first day when the replan is triggered by falling behind schedule', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidBehindSchedule')
    const tripRef = db.collection('trips').doc(tripId)
    await tripRef.update({ 'planMeta.status': 'ready' })

    planTripMock.mockReset().mockResolvedValue({ days: [{ index: 0 }] })
    resolveSkeletonDaysMock
      .mockReset()
      .mockResolvedValue([fixtureGeneratedDay(0, '2026-07-12', 'REPLANNED')])

    const { runReplan } = await import('./replanTrip.js')
    await runReplan(tripId, {
      currentLocation: { lat: 61.1, lng: 10.5 },
      today: '2026-07-12',
      completedRefPaths: [],
      remainingEndDate: '2026-07-14',
      remainingEndPoint: { name: 'Dombas', lat: 62.07, lng: 9.13 },
      behindScheduleKm: 337,
    })

    expect(planTripMock).toHaveBeenCalledWith(
      expect.objectContaining({
        notesFreeText: expect.stringMatching(/337km behind.*easy, short day/s),
      }),
    )
  })

  it('does not mention falling behind when the replan is a voluntary "Request changes" edit', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidVoluntaryReplan')
    const tripRef = db.collection('trips').doc(tripId)
    await tripRef.update({ 'planMeta.status': 'ready' })

    planTripMock.mockReset().mockResolvedValue({ days: [{ index: 0 }] })
    resolveSkeletonDaysMock
      .mockReset()
      .mockResolvedValue([fixtureGeneratedDay(0, '2026-07-12', 'REPLANNED')])

    const { runReplan } = await import('./replanTrip.js')
    await runReplan(tripId, {
      currentLocation: { lat: 61.1, lng: 10.5 },
      today: '2026-07-12',
      completedRefPaths: [],
      remainingEndDate: '2026-07-14',
      remainingEndPoint: { name: 'Dombas', lat: 62.07, lng: 9.13 },
      changeRequestText: 'more beaches',
    })

    expect(planTripMock).toHaveBeenCalledWith(
      expect.objectContaining({
        notesFreeText: expect.not.stringContaining('behind the original plan'),
      }),
    )
  })

  it('preserves a corridor stop linked only to a past day, and rematerializes one linked to a regenerated future day', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidCorridorReplan')
    const tripRef = db.collection('trips').doc(tripId)

    const pastDay: TripDay = {
      index: 0,
      date: '2026-07-11',
      type: 'drive',
      overnight: { name: 'Otta', lat: 61.77, lng: 9.54, country: 'NO' },
      drive: {
        fromName: 'Lillehammer',
        toName: 'Otta',
        distanceKm: 140,
        durationMin: 120,
        slot: 'midday',
      },
      summary: 'ORIGINAL day 1',
    }
    const staleFutureDay: TripDay = {
      index: 1,
      date: '2026-07-12',
      type: 'drive',
      overnight: { name: 'Dombas', lat: 62.07, lng: 9.13, country: 'NO' },
      drive: {
        fromName: 'Otta',
        toName: 'Dombas',
        distanceKm: 50,
        durationMin: 45,
        slot: 'morning',
      },
      summary: 'STALE — should be replaced by replan',
    }
    const pastDayRef = tripRef.collection('days').doc()
    const staleFutureDayRef = tripRef.collection('days').doc()
    await pastDayRef.set(pastDay)
    await staleFutureDayRef.set(staleFutureDay)
    await tripRef.update({ 'planMeta.status': 'ready' })

    const preservedStopRef = tripRef.collection('corridorStops').doc()
    await preservedStopRef.set({
      name: 'Otta',
      lat: 61.77,
      lng: 9.54,
      country: 'NO',
      status: 'committed',
      linkedDayIds: [pastDayRef.id],
    } satisfies CorridorStop)

    const staleStopRef = tripRef.collection('corridorStops').doc()
    await staleStopRef.set({
      name: 'Dombas',
      lat: 62.07,
      lng: 9.13,
      country: 'NO',
      status: 'committed',
      linkedDayIds: [staleFutureDayRef.id],
    } satisfies CorridorStop)

    planTripMock.mockReset().mockResolvedValue({ days: [{ index: 0 }] })
    resolveSkeletonDaysMock.mockReset().mockImplementation(
      async (
        skeletonDays: { index: number }[],
        _startLocation: unknown,
        onDayResolved?: (count: number) => void,
      ) => {
        const result = skeletonDays.map((d) =>
          fixtureGeneratedDay(d.index, '2026-07-12', 'REPLANNED'),
        )
        onDayResolved?.(result.length)
        return result
      },
    )

    const { runReplan } = await import('./replanTrip.js')
    await runReplan(tripId, {
      currentLocation: { lat: 61.77, lng: 9.54 },
      today: '2026-07-12',
      completedRefPaths: [],
      remainingEndDate: '2026-07-12',
      remainingEndPoint: { name: 'Stop 0', lat: 61, lng: 9 },
    })

    const corridorSnap = await tripRef.collection('corridorStops').get()
    const stops = corridorSnap.docs.map((d) => d.data() as CorridorStop)

    // Preserved: still linked only to the past day, untouched by the replan.
    const ottaStop = stops.find((s) => s.name === 'Otta')
    expect(ottaStop?.linkedDayIds).toEqual([pastDayRef.id])

    // Stale: no surviving stop still points at the deleted Dombas day.
    expect(
      stops.some((s) => s.linkedDayIds.includes(staleFutureDayRef.id)),
    ).toBe(false)

    // Fresh: a new committed stop exists for the regenerated day.
    const newDaysSnap = await tripRef.collection('days').orderBy('date').get()
    const newDay = newDaysSnap.docs.find((d) => d.id !== pastDayRef.id)
    expect(newDay).toBeDefined()
    const newStop = stops.find(
      (s) => newDay && s.linkedDayIds.includes(newDay.id),
    )
    expect(newStop?.status).toBe('committed')
  })
})
