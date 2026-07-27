import { getFirestore } from 'firebase-admin/firestore'
import { initializeApp } from 'firebase-admin/app'
import { beforeAll, describe, expect, it } from 'vitest'
import { createTripForUser } from './trips.js'

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

describe('cost guards', () => {
  it('rejects a new plan request while another is already active for the trip', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidCostGuardA')
    const tripRef = db.collection('trips').doc(tripId)

    // Simulate a plan request that's already mid-flight.
    await tripRef.update({ 'planMeta.status': 'generating' })

    const requestRef = await db.collection('planRequests').add({
      tripId,
      kind: 'full',
      status: 'pending',
    })

    const finalRequest = await waitFor(async () => {
      const snap = await requestRef.get()
      const data = snap.data()
      return data?.status === 'error' ? data : undefined
    })

    expect(finalRequest.error).toMatch(/already in progress/)

    // The guard must not have touched the in-flight status.
    const tripSnap = await tripRef.get()
    expect(tripSnap.data()?.planMeta.status).toBe('generating')
  }, 15_000)
})
