import { getFirestore, type Firestore } from 'firebase-admin/firestore'
import { initializeApp } from 'firebase-admin/app'
import { beforeAll, describe, expect, it } from 'vitest'
import { createTripForUser } from './trips.js'
import { runInsertRestDay } from './insertRestDay.js'
import type { CorridorStop, TripDay } from '@rv/shared'

const PROJECT_ID = 'demo-rv-trip-planner'

beforeAll(() => {
  initializeApp({ projectId: PROJECT_ID })
  getFirestore().settings({ ignoreUndefinedProperties: true })
})

async function waitFor<T>(
  fn: () => Promise<T | undefined>,
  timeoutMs = 15_000,
): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const result = await fn()
    if (result !== undefined) return result
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('Timed out waiting for condition')
}

function driveDay(index: number, date: string, name: string): TripDay {
  return {
    index,
    date,
    type: 'drive',
    overnight: { name, lat: 61 + index / 10, lng: 9 + index / 10, country: 'NO' },
    drive: {
      fromName: `Stop ${index - 1}`,
      toName: name,
      distanceKm: 100 + index,
      durationMin: 90 + index,
      slot: 'morning',
    },
    summary: `Day ${index} to ${name}`,
  }
}

function activityFixture(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    category: 'sight' as const,
    lat: 61.1,
    lng: 10.5,
    blurb: `About ${name}`,
    kidFriendly: true,
    status: 'suggested' as const,
    ...extra,
  }
}

function restaurantFixture(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    meal: 'dinner' as const,
    lat: 61.1,
    lng: 10.5,
    blurb: `About ${name}`,
    status: 'suggested' as const,
    ...extra,
  }
}

/** Seeds days + subcollections, chunked so the seeding itself can't hit the
 * 500-op batch cap on the long-trip fixture. */
async function seedDays(
  db: Firestore,
  tripId: string,
  days: {
    day: TripDay
    activities?: Record<string, unknown>[]
    restaurants?: Record<string, unknown>[]
  }[],
) {
  const tripRef = db.collection('trips').doc(tripId)
  for (const { day, activities = [], restaurants = [] } of days) {
    const batch = db.batch()
    const dayRef = tripRef.collection('days').doc(day.date)
    batch.set(dayRef, day)
    activities.forEach((a, i) =>
      batch.set(dayRef.collection('activities').doc(`a${i}`), a),
    )
    restaurants.forEach((r, i) =>
      batch.set(dayRef.collection('restaurants').doc(`r${i}`), r),
    )
    await batch.commit()
  }
  await tripRef.update({ 'planMeta.status': 'ready' })
}

describe('insertRestDay', () => {
  it('inserts a rest day in place and shifts every later day back by exactly one', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidInsertBasic')
    const tripRef = db.collection('trips').doc(tripId)

    await seedDays(db, tripId, [
      {
        day: driveDay(0, '2026-07-10', 'Lillehammer'),
        activities: [
          activityFixture('Maihaugen', {
            status: 'done',
            doneAt: '2026-07-10T18:00:00Z',
            diaryNote: 'kids loved it',
          }),
          activityFixture('Riverside walk', { status: 'selected' }),
        ],
        restaurants: [
          restaurantFixture('Bryggerikjelleren', {
            status: 'done',
            doneAt: '2026-07-10T20:00:00Z',
          }),
        ],
      },
      {
        day: driveDay(1, '2026-07-11', 'Otta'),
        activities: [activityFixture('Rondane hike')],
        restaurants: [restaurantFixture('Otta Kafe', { meal: 'lunch' })],
      },
      {
        day: {
          ...driveDay(2, '2026-07-12', 'Dombas'),
          extraTimeReason: 'worth a slow morning',
        },
        activities: [activityFixture('Dovrefjell viewpoint')],
        restaurants: [restaurantFixture('Dombas Kro')],
      },
    ])
    await tripRef.update({ 'settings.endDate': '2026-07-12' })

    await runInsertRestDay(tripId, '2026-07-10')

    const daysSnap = await tripRef.collection('days').orderBy('date').get()
    expect(daysSnap.docs.map((d) => d.data().date)).toEqual([
      '2026-07-10',
      '2026-07-11',
      '2026-07-12',
      '2026-07-13',
    ])

    // The day the traveler chose to extend: completely untouched.
    const unchanged = daysSnap.docs[0].data() as TripDay
    expect(unchanged).toEqual(
      expect.objectContaining({
        index: 0,
        date: '2026-07-10',
        type: 'drive',
        summary: 'Day 0 to Lillehammer',
      }),
    )

    // The inserted day: same overnight (they're staying put), no drive.
    const inserted = daysSnap.docs[1].data() as TripDay
    expect(inserted.index).toBe(1)
    expect(inserted.date).toBe('2026-07-11')
    expect(inserted.type).toBe('rest')
    expect(inserted.overnight).toEqual(unchanged.overnight)
    expect(inserted.drive).toBeUndefined()
    expect(inserted.summary).toContain('Lillehammer')

    // Later days: one day later, one index higher, content otherwise intact.
    const shiftedOtta = daysSnap.docs[2].data() as TripDay
    expect(shiftedOtta).toEqual({
      ...driveDay(1, '2026-07-11', 'Otta'),
      date: '2026-07-12',
      index: 2,
    })
    const shiftedDombas = daysSnap.docs[3].data() as TripDay
    expect(shiftedDombas).toEqual({
      ...driveDay(2, '2026-07-12', 'Dombas'),
      extraTimeReason: 'worth a slow morning',
      date: '2026-07-13',
      index: 3,
    })

    // Shifted days keep their own activities/restaurants, not a copy of
    // somebody else's.
    const ottaActivities = await daysSnap.docs[2].ref
      .collection('activities')
      .get()
    expect(ottaActivities.docs.map((d) => d.data().name)).toEqual([
      'Rondane hike',
    ])
    const ottaRestaurants = await daysSnap.docs[2].ref
      .collection('restaurants')
      .get()
    expect(ottaRestaurants.docs.map((d) => d.data().name)).toEqual(['Otta Kafe'])

    // The new day starts from the extended day's already-vetted suggestions,
    // but inherits none of its selections, completions or diary notes.
    const newActivities = await daysSnap.docs[1].ref
      .collection('activities')
      .get()
    expect(newActivities.docs.map((d) => d.data().name).sort()).toEqual([
      'Maihaugen',
      'Riverside walk',
    ])
    for (const doc of newActivities.docs) {
      expect(doc.data().status).toBe('suggested')
      expect(doc.data().doneAt).toBeUndefined()
      expect(doc.data().diaryNote).toBeUndefined()
    }
    const newRestaurants = await daysSnap.docs[1].ref
      .collection('restaurants')
      .get()
    expect(newRestaurants.docs.map((d) => d.data().name)).toEqual([
      'Bryggerikjelleren',
    ])
    expect(newRestaurants.docs[0].data().status).toBe('suggested')
    expect(newRestaurants.docs[0].data().doneAt).toBeUndefined()

    // The source day's own suggestions keep their real state.
    const sourceActivities = await daysSnap.docs[0].ref
      .collection('activities')
      .get()
    expect(
      sourceActivities.docs.map((d) => d.data().status).sort(),
    ).toEqual(['done', 'selected'])

    const trip = (await tripRef.get()).data()
    // The trip is genuinely one calendar day longer now.
    expect(trip?.settings.endDate).toBe('2026-07-13')
    expect(trip?.planMeta.status).toBe('ready')
    // No drive was added or removed, so the totals are unchanged — but they
    // are recomputed rather than left stale.
    expect(trip?.planMeta.totalKm).toBe(303)
    expect(trip?.planMeta.avgDriveMinutesPerDay).toBeCloseTo(91)
  }, 30_000)

  it('handles a trip whose shifted tail needs more than one 500-op Firestore batch', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidInsertLongTrip')
    const tripRef = db.collection('trips').doc(tripId)

    // 25 shifted days x (1 day write + 1 day delete + 2 ops for each of 13
    // subcollection docs) = 700 operations, comfortably past the 500 cap a
    // single WriteBatch allows.
    const DAY_COUNT = 26
    const seed = Array.from({ length: DAY_COUNT }, (_, i) => ({
      day: driveDay(i, `2026-08-${String(i + 1).padStart(2, '0')}`, `Stop ${i}`),
      activities: Array.from({ length: 6 }, (_, a) =>
        activityFixture(`Day ${i} activity ${a}`),
      ),
      restaurants: Array.from({ length: 7 }, (_, r) =>
        restaurantFixture(`Day ${i} restaurant ${r}`),
      ),
    }))
    await seedDays(db, tripId, seed)
    await tripRef.update({ 'settings.endDate': '2026-08-26' })

    await runInsertRestDay(tripId, '2026-08-01')

    const daysSnap = await tripRef.collection('days').orderBy('date').get()
    expect(daysSnap.size).toBe(DAY_COUNT + 1)
    expect(daysSnap.docs.map((d) => d.data().date)).toEqual([
      '2026-08-01',
      ...Array.from({ length: DAY_COUNT }, (_, i) =>
        `2026-08-${String(i + 2).padStart(2, '0')}`,
      ),
    ])
    // Indices stay contiguous.
    daysSnap.docs.forEach((doc, i) => {
      const day = doc.data() as TripDay
      expect(day.index).toBe(i)
    })

    // Every shifted day kept all 13 of its own subcollection docs — nothing
    // was dropped or duplicated at a batch boundary.
    const lastShifted = daysSnap.docs[DAY_COUNT]
    const [activities, restaurants] = await Promise.all([
      lastShifted.ref.collection('activities').get(),
      lastShifted.ref.collection('restaurants').get(),
    ])
    expect(activities.size).toBe(6)
    expect(restaurants.size).toBe(7)
    expect(activities.docs[0].data().name).toContain(`Day ${DAY_COUNT - 1} `)

    // A mid-tail day, to be sure it isn't just the ends that survived.
    const midDay = daysSnap.docs[13].data() as TripDay
    expect(midDay.summary).toBe(`Day 12 to Stop 12`)
    const midActivities = await daysSnap.docs[13].ref
      .collection('activities')
      .get()
    expect(midActivities.size).toBe(6)

    const trip = (await tripRef.get()).data()
    expect(trip?.settings.endDate).toBe('2026-08-27')
    expect(trip?.planMeta.status).toBe('ready')
  }, 120_000)

  it('fails loudly when the day to insert after does not exist', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidInsertMissingDay')
    await seedDays(db, tripId, [{ day: driveDay(0, '2026-07-10', 'Otta') }])

    await expect(runInsertRestDay(tripId, '2026-09-30')).rejects.toThrow(
      /2026-09-30/,
    )
    const daysSnap = await db
      .collection('trips')
      .doc(tripId)
      .collection('days')
      .get()
    expect(daysSnap.size).toBe(1)
  }, 30_000)

  it('inserting after the final day just appends the rest day', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidInsertAtEnd')
    const tripRef = db.collection('trips').doc(tripId)
    await seedDays(db, tripId, [
      { day: driveDay(0, '2026-07-10', 'Lillehammer') },
      { day: driveDay(1, '2026-07-11', 'Otta') },
    ])

    await runInsertRestDay(tripId, '2026-07-11')

    const daysSnap = await tripRef.collection('days').orderBy('date').get()
    expect(daysSnap.docs.map((d) => d.data().date)).toEqual([
      '2026-07-10',
      '2026-07-11',
      '2026-07-12',
    ])
    const appended = daysSnap.docs[2].data() as TripDay
    expect(appended.type).toBe('rest')
    expect(appended.index).toBe(2)
    expect(appended.overnight.name).toBe('Otta')
  }, 30_000)

  it('is rejected by the cost guard while another plan operation is already running', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidInsertCostGuard')
    const tripRef = db.collection('trips').doc(tripId)
    await seedDays(db, tripId, [
      { day: driveDay(0, '2026-07-10', 'Lillehammer') },
      { day: driveDay(1, '2026-07-11', 'Otta') },
    ])
    // A plan operation is already in flight for this trip.
    await tripRef.update({ 'planMeta.status': 'generating' })

    const requestRef = await db.collection('planRequests').add({
      tripId,
      kind: 'insertRestDay',
      insertRestDayContext: { afterDayId: '2026-07-10' },
      status: 'pending',
    })

    const request = await waitFor(async () => {
      const snap = await requestRef.get()
      return snap.data()?.status === 'error' ? snap.data() : undefined
    })
    expect(request?.error).toContain('already in progress')

    // Nothing was inserted or shifted.
    const daysSnap = await tripRef.collection('days').orderBy('date').get()
    expect(daysSnap.docs.map((d) => d.data().date)).toEqual([
      '2026-07-10',
      '2026-07-11',
    ])
  }, 30_000)

  it('runs end to end through the planRequests trigger when the trip is idle', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidInsertViaTrigger')
    const tripRef = db.collection('trips').doc(tripId)
    await seedDays(db, tripId, [
      {
        day: driveDay(0, '2026-07-10', 'Lillehammer'),
        activities: [activityFixture('Maihaugen')],
      },
      { day: driveDay(1, '2026-07-11', 'Otta') },
    ])

    const requestRef = await db.collection('planRequests').add({
      tripId,
      kind: 'insertRestDay',
      insertRestDayContext: { afterDayId: '2026-07-10' },
      status: 'pending',
    })

    await waitFor(async () => {
      const snap = await requestRef.get()
      return snap.data()?.status === 'done' ? snap.data() : undefined
    })

    const daysSnap = await tripRef.collection('days').orderBy('date').get()
    expect(daysSnap.docs.map((d) => d.data().date)).toEqual([
      '2026-07-10',
      '2026-07-11',
      '2026-07-12',
    ])
    expect((daysSnap.docs[1].data() as TripDay).type).toBe('rest')
    expect((daysSnap.docs[2].data() as TripDay).summary).toBe('Day 1 to Otta')
    expect((await tripRef.get()).data()?.planMeta.status).toBe('ready')
  }, 30_000)

  it('errors clearly when the request carries no insertRestDayContext', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidInsertNoContext')
    await seedDays(db, tripId, [{ day: driveDay(0, '2026-07-10', 'Otta') }])

    const requestRef = await db.collection('planRequests').add({
      tripId,
      kind: 'insertRestDay',
      status: 'pending',
    })

    const request = await waitFor(async () => {
      const snap = await requestRef.get()
      return snap.data()?.status === 'error' ? snap.data() : undefined
    })
    expect(request?.error).toContain('insertRestDayContext')
  }, 30_000)

  it("links the inserted rest day into the extended day's existing corridor stop", async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidInsertCorridorLink')
    const tripRef = db.collection('trips').doc(tripId)
    const lillehammer = driveDay(0, '2026-07-10', 'Lillehammer')
    await seedDays(db, tripId, [
      { day: lillehammer },
      { day: driveDay(1, '2026-07-11', 'Otta') },
    ])

    const stopRef = tripRef.collection('corridorStops').doc()
    await stopRef.set({
      name: 'Lillehammer',
      lat: lillehammer.overnight.lat,
      lng: lillehammer.overnight.lng,
      country: 'NO',
      status: 'committed',
      linkedDayIds: ['2026-07-10'],
    } satisfies CorridorStop)

    await runInsertRestDay(tripId, '2026-07-10')

    const daysSnap = await tripRef.collection('days').orderBy('date').get()
    const insertedDay = daysSnap.docs[1]
    expect(insertedDay.data().type).toBe('rest')

    const stopSnap = await stopRef.get()
    const stop = stopSnap.data() as CorridorStop
    expect(stop.linkedDayIds).toEqual(['2026-07-10', insertedDay.id])
  }, 30_000)

  it('leaves corridor stops alone when none exists yet for the extended day', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidInsertNoCorridor')
    const tripRef = db.collection('trips').doc(tripId)
    await seedDays(db, tripId, [
      { day: driveDay(0, '2026-07-10', 'Lillehammer') },
      { day: driveDay(1, '2026-07-11', 'Otta') },
    ])

    await runInsertRestDay(tripId, '2026-07-10')

    const corridorSnap = await tripRef.collection('corridorStops').get()
    expect(corridorSnap.empty).toBe(true)
  }, 30_000)
})
