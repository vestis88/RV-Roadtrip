import { getFirestore } from 'firebase-admin/firestore'
import { initializeApp } from 'firebase-admin/app'
import { beforeAll, describe, expect, it } from 'vitest'
import { createTripForUser } from './trips.js'
import { validatePacing } from './pacingValidator.js'
import type { TripDay } from '@rv/shared'

const PROJECT_ID = 'demo-rv-trip-planner'

beforeAll(() => {
  initializeApp({ projectId: PROJECT_ID })
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

describe('replanTrip', () => {
  it('leaves past days untouched, regenerates the remainder, and keeps the plan well-paced', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidA')
    const tripRef = db.collection('trips').doc(tripId)

    // Seed a fixture trip "mid-way": two past days (with a marker so we can
    // detect if replan touches them) and one future day due to be replaced.
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
      await dayRef.collection('activities').add({
        name: 'placeholder',
        category: 'sight',
        lat: day.overnight.lat,
        lng: day.overnight.lng,
        blurb: 'placeholder',
        kidFriendly: true,
        status: 'suggested',
      })
    }
    await tripRef.update({ 'planMeta.status': 'ready' })

    await db.collection('planRequests').add({
      tripId,
      kind: 'replan',
      status: 'pending',
      replanContext: {
        currentLocation: { lat: 61.77, lng: 9.54 },
        today: '2026-07-12',
        completedRefPaths: [
          `trips/${tripId}/days/2026-07-10`,
          `trips/${tripId}/days/2026-07-11`,
        ],
        remainingEndDate: '2026-07-13',
        remainingEndPoint: { name: 'Dombas', lat: 62.07, lng: 9.13 },
      },
    })

    // Guard against matching the seed's own 'ready' write before the
    // replan has actually run: wait specifically for lastReplanAt.
    const trip = await waitFor(async () => {
      const snap = await tripRef.get()
      const data = snap.data()
      return data?.planMeta?.status === 'ready' && data.planMeta.lastReplanAt
        ? data
        : undefined
    })

    expect(trip.planMeta.lastReplanAt).toBeDefined()

    // Past days: untouched.
    const day1Snap = await tripRef.collection('days').doc('2026-07-10').get()
    const day2Snap = await tripRef.collection('days').doc('2026-07-11').get()
    expect(day1Snap.data()?.summary).toBe('ORIGINAL day 1')
    expect(day2Snap.data()?.summary).toBe('ORIGINAL day 2')

    // Stale future day: replaced, not left in place.
    const staleSnap = await tripRef.collection('days').doc('2026-07-12').get()
    expect(staleSnap.data()?.summary).not.toBe(
      'STALE — should be replaced by replan',
    )

    // New remainder day at the requested end date exists.
    const finalDaySnap = await tripRef
      .collection('days')
      .doc('2026-07-13')
      .get()
    expect(finalDaySnap.exists).toBe(true)

    // The regenerated remainder (past days are historical fact and aren't
    // re-paced) respects Section 5's pacing rules.
    const remainderDays = [
      staleSnap.data() as TripDay,
      finalDaySnap.data() as TripDay,
    ]
    expect(validatePacing(remainderDays)).toBeNull()
  }, 15_000)
})
