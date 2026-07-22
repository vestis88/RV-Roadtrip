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
  // generatePlan now runs the real pipeline (planTrip via Claude, then
  // Routes + Places for each day) instead of a hardcoded fixture. That
  // pipeline has no synthetic fallback by design (same as T-16/T-18) — it
  // needs CLAUDE_API_KEY and GOOGLE_PLACES_API_KEY, which this local
  // emulator setup doesn't have configured. This test instead confirms the
  // trigger correctly attempts the real pipeline and fails gracefully
  // (a clear planMeta.error, not a crash or an infinite 'generating') when
  // those secrets aren't available — the actual "produces a ready plan"
  // path is a live check against the deployed project, which does have
  // real secrets configured.
  it('attempts the real pipeline and surfaces a clear error without Claude/Places credentials', async () => {
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
      return data?.planMeta?.status === 'error' ? data : undefined
    })

    expect(trip.planMeta.status).toBe('error')
    expect(trip.planMeta.error).toBeTruthy()

    const daysSnap = await db
      .collection('trips')
      .doc(tripId)
      .collection('days')
      .get()
    expect(daysSnap.size).toBe(0)
  }, 15_000)
})
