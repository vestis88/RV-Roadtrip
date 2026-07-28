import { getFirestore, type Firestore } from 'firebase-admin/firestore'
import { initializeApp } from 'firebase-admin/app'
import { beforeAll, describe, expect, it } from 'vitest'
import { createTripForUser } from './trips.js'
import { writeGeneratedDays } from './generatePlan.js'
import type { GeneratedDay } from './planPipeline.js'
import type { Activity, Restaurant, TripDay } from '@rv/shared'

const PROJECT_ID = 'demo-rv-trip-planner'

beforeAll(() => {
  initializeApp({ projectId: PROJECT_ID })
  getFirestore().settings({ ignoreUndefinedProperties: true })
})

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
      slot: 'evening',
    },
    summary: `Day ${index} to ${name}`,
  }
}

function activity(name: string, extra: Partial<Activity> = {}): Activity {
  return {
    name,
    category: 'sight',
    lat: 61.1,
    lng: 10.5,
    blurb: `About ${name}`,
    kidFriendly: true,
    status: 'suggested',
    ...extra,
  }
}

function restaurant(name: string, extra: Partial<Restaurant> = {}): Restaurant {
  return {
    name,
    meal: 'dinner',
    lat: 61.1,
    lng: 10.5,
    blurb: `About ${name}`,
    status: 'suggested',
    ...extra,
  }
}

/** Seeds an "old generation" directly, bypassing writeGeneratedDays. */
async function seedDays(
  db: Firestore,
  tripId: string,
  days: { day: TripDay; activities?: Activity[]; restaurants?: Restaurant[] }[],
) {
  const tripRef = db.collection('trips').doc(tripId)
  for (const { day, activities = [], restaurants = [] } of days) {
    const batch = db.batch()
    const dayRef = tripRef.collection('days').doc(day.date)
    batch.set(dayRef, day)
    activities.forEach((a, i) =>
      batch.set(dayRef.collection('activities').doc(`old-a${i}`), a),
    )
    restaurants.forEach((r, i) =>
      batch.set(dayRef.collection('restaurants').doc(`old-r${i}`), r),
    )
    await batch.commit()
  }
}

function generatedDay(
  index: number,
  date: string,
  name: string,
  activities: Activity[],
  restaurants: Restaurant[],
): GeneratedDay {
  return { day: driveDay(index, date, name), activities, restaurants }
}

describe('writeGeneratedDays', () => {
  it('replaces a day sitting at an already-used date instead of accumulating alongside it', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidRegenSameDate')
    const tripRef = db.collection('trips').doc(tripId)

    // "Previous generation": Lübeck on 2026-07-11.
    await seedDays(db, tripId, [
      {
        day: driveDay(0, '2026-07-11', 'Lübeck'),
        activities: [activity('Hansa-Park'), activity('Museum Holstentor')],
        restaurants: [restaurant('Lübeck Marzipan Cafe')],
      },
    ])

    // "New generation" after the destination changed: Copenhagen on the same
    // date, from a fresh writeGeneratedDays call — the exact call site
    // (re)generation goes through.
    await writeGeneratedDays(tripRef, [
      generatedDay(
        0,
        '2026-07-11',
        'Copenhagen',
        [activity('Tivoli Gardens')],
        [restaurant('Nyhavn Bistro')],
      ),
    ])

    const daySnap = await tripRef.collection('days').doc('2026-07-11').get()
    expect(daySnap.data()?.overnight.name).toBe('Copenhagen')

    const activitiesSnap = await tripRef
      .collection('days')
      .doc('2026-07-11')
      .collection('activities')
      .get()
    expect(activitiesSnap.docs.map((d) => d.data().name)).toEqual([
      'Tivoli Gardens',
    ])

    const restaurantsSnap = await tripRef
      .collection('days')
      .doc('2026-07-11')
      .collection('restaurants')
      .get()
    expect(restaurantsSnap.docs.map((d) => d.data().name)).toEqual([
      'Nyhavn Bistro',
    ])
  })

  it('removes an old day whose date is not present in the new plan at all', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidRegenShorter')
    const tripRef = db.collection('trips').doc(tripId)

    await seedDays(db, tripId, [
      {
        day: driveDay(0, '2026-07-10', 'Oslo'),
        activities: [activity('Vigeland Park')],
      },
      {
        day: driveDay(1, '2026-07-11', 'Lübeck'),
        activities: [activity('Hansa-Park')],
      },
    ])

    // The new (shorter) plan only covers 2026-07-10.
    await writeGeneratedDays(tripRef, [
      generatedDay(0, '2026-07-10', 'Oslo', [activity('Opera House')], []),
    ])

    const daysSnap = await tripRef.collection('days').get()
    expect(daysSnap.docs.map((d) => d.id)).toEqual(['2026-07-10'])

    const orphanedActivities = await tripRef
      .collection('days')
      .doc('2026-07-11')
      .collection('activities')
      .get()
    expect(orphanedActivities.size).toBe(0)
  })

  it('writes a brand new trip with no prior days as a plain no-op wipe', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidFreshTrip')
    const tripRef = db.collection('trips').doc(tripId)

    await writeGeneratedDays(tripRef, [
      generatedDay(0, '2026-07-10', 'Oslo', [activity('Vigeland Park')], []),
    ])

    const daysSnap = await tripRef.collection('days').get()
    expect(daysSnap.docs.map((d) => d.id)).toEqual(['2026-07-10'])
  })

  it('handles a regeneration large enough that clearing the old days alone exceeds one Firestore batch', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidRegenLarge')
    const tripRef = db.collection('trips').doc(tripId)

    // 20 old days x (1 day doc + 5 activities + 9 restaurants) = 300
    // operations just to delete — comfortably enough to require this test to
    // actually exercise commitInChunks rather than a single batch.
    const oldDays = Array.from({ length: 20 }, (_, i) => {
      const date = `2026-07-${String(10 + i).padStart(2, '0')}`
      return {
        day: driveDay(i, date, `Old town ${i}`),
        activities: Array.from({ length: 5 }, (_, a) =>
          activity(`Old activity ${i}-${a}`),
        ),
        restaurants: Array.from({ length: 9 }, (_, r) =>
          restaurant(`Old restaurant ${i}-${r}`),
        ),
      }
    })
    await seedDays(db, tripId, oldDays)

    const newDays = Array.from({ length: 20 }, (_, i) => {
      const date = `2026-07-${String(10 + i).padStart(2, '0')}`
      return generatedDay(
        i,
        date,
        `New town ${i}`,
        Array.from({ length: 5 }, (_, a) => activity(`New activity ${i}-${a}`)),
        Array.from({ length: 9 }, (_, r) => restaurant(`New restaurant ${i}-${r}`)),
      )
    })

    await writeGeneratedDays(tripRef, newDays)

    const daysSnap = await tripRef.collection('days').orderBy('date').get()
    expect(daysSnap.size).toBe(20)
    for (const doc of daysSnap.docs) {
      expect(doc.data().overnight.name).toMatch(/^New town/)
      const activitiesSnap = await doc.ref.collection('activities').get()
      expect(activitiesSnap.size).toBe(5)
      for (const activityDoc of activitiesSnap.docs) {
        expect(activityDoc.data().name).toMatch(/^New activity/)
      }
      const restaurantsSnap = await doc.ref.collection('restaurants').get()
      expect(restaurantsSnap.size).toBe(9)
      for (const restaurantDoc of restaurantsSnap.docs) {
        expect(restaurantDoc.data().name).toMatch(/^New restaurant/)
      }
    }
  }, 30_000)
})
