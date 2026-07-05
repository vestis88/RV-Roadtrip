import { getFirestore } from 'firebase-admin/firestore'
import { initializeApp } from 'firebase-admin/app'
import { beforeAll, describe, expect, it } from 'vitest'
import { createTripForUser } from './trips.js'

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

describe('generatePlan', () => {
  it('writes a fixture plan and marks planMeta ready when a planRequest is created', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidA')

    await db.collection('planRequests').add({
      tripId,
      kind: 'full',
      status: 'pending',
    })

    const trip = await waitFor(async () => {
      const snap = await db.collection('trips').doc(tripId).get()
      const data = snap.data()
      return data?.planMeta?.status === 'ready' ? data : undefined
    })

    expect(trip.planMeta.status).toBe('ready')
    expect(trip.planMeta.totalKm).toBeGreaterThan(0)
    expect(trip.planMeta.avgDriveMinutesPerDay).toBeGreaterThan(0)

    const daysSnap = await db
      .collection('trips')
      .doc(tripId)
      .collection('days')
      .get()
    expect(daysSnap.size).toBe(3)

    for (const dayDoc of daysSnap.docs) {
      const activities = await dayDoc.ref.collection('activities').get()
      const restaurants = await dayDoc.ref.collection('restaurants').get()
      expect(activities.size).toBeGreaterThan(0)
      expect(restaurants.size).toBeGreaterThan(0)
    }
  }, 15_000)
})
