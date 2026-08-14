import {
  getFirestore,
  type DocumentReference,
  type Firestore,
} from 'firebase-admin/firestore'
import { initializeApp } from 'firebase-admin/app'
import { beforeAll, describe, expect, it } from 'vitest'
import { createTripForUser } from './trips.js'
import { writeGeneratedDays } from './generatePlan.js'
import type { GeneratedDay } from './planPipeline.js'
import type { Activity, CorridorStop, Restaurant, TripDay } from '@rv/shared'

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

/** Day docs have stable, auto-generated IDs, not date-keyed ones — look one
 * up by its `date` field instead of assuming the ID matches. */
async function dayByDate(tripRef: DocumentReference, date: string) {
  const snap = await tripRef
    .collection('days')
    .where('date', '==', date)
    .limit(1)
    .get()
  if (snap.empty) throw new Error(`No day found for date ${date}`)
  return snap.docs[0]
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

    const dayDoc = await dayByDate(tripRef, '2026-07-11')
    expect(dayDoc.data()?.overnight.name).toBe('Copenhagen')

    const activitiesSnap = await dayDoc.ref.collection('activities').get()
    expect(activitiesSnap.docs.map((d) => d.data().name)).toEqual([
      'Tivoli Gardens',
    ])

    const restaurantsSnap = await dayDoc.ref.collection('restaurants').get()
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
    expect(daysSnap.docs.map((d) => d.data().date)).toEqual(['2026-07-10'])

    // The 2026-07-11 day no longer exists at all — no doc under any ID has
    // that date any more, so there's nothing to query orphaned activities
    // under.
    const remainingDates = daysSnap.docs.map((d) => d.data().date)
    expect(remainingDates).not.toContain('2026-07-11')
  })

  it('writes a brand new trip with no prior days as a plain no-op wipe', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidFreshTrip')
    const tripRef = db.collection('trips').doc(tripId)

    await writeGeneratedDays(tripRef, [
      generatedDay(0, '2026-07-10', 'Oslo', [activity('Vigeland Park')], []),
    ])

    const daysSnap = await tripRef.collection('days').get()
    expect(daysSnap.docs.map((d) => d.data().date)).toEqual(['2026-07-10'])
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

  it('rebuilds committed corridorStops from the new days', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidCorridorRegen')
    const tripRef = db.collection('trips').doc(tripId)

    // A stale corridor stop left over from a previous generation, linked to
    // a day ID that no longer exists — must not survive the regeneration.
    await tripRef.collection('corridorStops').add({
      name: 'Stale town',
      lat: 1,
      lng: 1,
      country: 'NO',
      status: 'committed',
      linkedDayIds: ['stale-day-id'],
    } satisfies CorridorStop)

    await writeGeneratedDays(tripRef, [
      generatedDay(0, '2026-07-10', 'Oslo', [activity('Vigeland Park')], []),
    ])

    const corridorSnap = await tripRef.collection('corridorStops').get()
    expect(corridorSnap.size).toBe(1)
    const stop = corridorSnap.docs[0].data() as CorridorStop
    expect(stop.name).toBe('Oslo')
    expect(stop.status).toBe('committed')

    const daysSnap = await tripRef.collection('days').get()
    expect(stop.linkedDayIds).toEqual([daysSnap.docs[0].id])
  })

  // Reported 2026-08-12: this used to delete EVERY corridorStop, so the first
  // generation destroyed the whole researched set — every stop marked worth a
  // detour that did not make the route, gone, recoverable only by paying
  // Claude to research the corridor again. replanTrip never did this; it
  // deletes only stops linked to days it is replacing.
  it('keeps the traveler research that is not part of the plan', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidCorridorPreserve')
    const tripRef = db.collection('trips').doc(tripId)

    await tripRef.collection('corridorStops').add({
      name: 'Roros',
      lat: 62.57,
      lng: 11.38,
      country: 'NO',
      status: 'candidate',
      linkedDayIds: [],
      priority: 'worth-a-detour',
      why: 'A mining town that never made the cut.',
    } satisfies CorridorStop)
    await tripRef.collection('corridorStops').add({
      name: 'Traveler pin',
      lat: 63.4,
      lng: 10.4,
      country: 'NO',
      status: 'locked',
      linkedDayIds: [],
    } satisfies CorridorStop)

    await writeGeneratedDays(tripRef, [
      generatedDay(0, '2026-07-10', 'Oslo', [], []),
    ])

    const stops = (await tripRef.collection('corridorStops').get()).docs.map(
      (doc) => doc.data() as CorridorStop,
    )
    expect(stops.map((s) => s.name).sort()).toEqual([
      'Oslo',
      'Roros',
      'Traveler pin',
    ])
    // And the research keeps everything that made it useful.
    const roros = stops.find((s) => s.name === 'Roros')
    expect(roros?.priority).toBe('worth-a-detour')
    expect(roros?.why).toContain('mining town')
  })

  // The other half: a candidate the plan now routes through would otherwise
  // appear twice — once awaiting a decision, once already in the trip.
  it('drops a preserved candidate the new plan committed to anyway', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidCorridorDedupe')
    const tripRef = db.collection('trips').doc(tripId)

    await tripRef.collection('corridorStops').add({
      name: 'Oslo',
      // A slightly different geocode of the same town, as the highlights
      // pass and the day resolution genuinely produce.
      lat: 61.02,
      lng: 9.02,
      country: 'NO',
      status: 'locked',
      linkedDayIds: [],
    } satisfies CorridorStop)

    await writeGeneratedDays(tripRef, [
      generatedDay(0, '2026-07-10', 'Oslo', [], []),
    ])

    const stops = (await tripRef.collection('corridorStops').get()).docs.map(
      (doc) => doc.data() as CorridorStop,
    )
    expect(stops).toHaveLength(1)
    expect(stops[0].status).toBe('committed')
  })

  // Proximity means "the same town geocoded twice", which is only what it
  // means for a stop that IS a town. A curated sight sits a couple of
  // kilometres from the town it is seen from by design, so measuring it the
  // same way would quietly delete every sight near a town the plan happens
  // to sleep in — including the ones that did not make the route, which are
  // exactly the ones the traveler still has a decision to make about.
  it('keeps a curated sight sitting near a committed overnight town', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidCorridorSightNearTown')
    const tripRef = db.collection('trips').doc(tripId)

    await tripRef.collection('corridorStops').add({
      name: 'Louisiana Museum of Modern Art',
      // Well inside SAME_STOP_KM of the day's own overnight point below.
      lat: 61.01,
      lng: 9.01,
      country: 'NO',
      status: 'candidate',
      linkedDayIds: [],
      priority: 'worth-a-detour',
      baseTown: 'Oslo',
      interest: 'art',
      timeNeeded: 'half-day',
    } satisfies CorridorStop)

    await writeGeneratedDays(tripRef, [
      generatedDay(0, '2026-07-10', 'Oslo', [], []),
    ])

    const stops = (await tripRef.collection('corridorStops').get()).docs.map(
      (doc) => doc.data() as CorridorStop,
    )
    expect(stops.map((s) => s.name).sort()).toEqual([
      'Louisiana Museum of Modern Art',
      'Oslo',
    ])
  })
})
