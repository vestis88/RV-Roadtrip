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

  // Segmented generation (2026-07-31): a chained continuation request
  // (isContinuation: true — see generatePlan.ts's runFullGeneration) must
  // NOT be rejected by this same busy guard just because the trip is
  // 'generating' — that's expected, it's the parent invocation's own claim
  // still in effect, not a competing request.
  it('lets a continuation request through while the trip is generating, unlike a fresh request', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidCostGuardContinuation')
    const tripRef = db.collection('trips').doc(tripId)
    await tripRef.update({ 'planMeta.status': 'generating' })

    const requestRef = await db.collection('planRequests').add({
      tripId,
      kind: 'full',
      status: 'pending',
      isContinuation: true,
    })

    const finalRequest = await waitFor(async () => {
      const snap = await requestRef.get()
      const data = snap.data()
      return data?.status === 'error' ? data : undefined
    })

    // Got past the busy guard into the real pipeline attempt — the same
    // credential-less failure generatePlan.test.ts's 'full' test asserts —
    // rather than being turned away with "already in progress".
    expect(finalRequest.error).toBeTruthy()
    expect(finalRequest.error).not.toMatch(/already in progress/)
  }, 15_000)

  it('drops a continuation request whose trip is no longer generating, without touching the trip', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidCostGuardStaleContinuation')
    const tripRef = db.collection('trips').doc(tripId)
    // Trip is idle (never marked generating by a parent invocation) — a
    // stray/misfired continuation shouldn't be able to run against it.

    const requestRef = await db.collection('planRequests').add({
      tripId,
      kind: 'full',
      status: 'pending',
      isContinuation: true,
    })

    const finalRequest = await waitFor(async () => {
      const snap = await requestRef.get()
      const data = snap.data()
      return data?.status === 'error' ? data : undefined
    })

    expect(finalRequest.error).toMatch(/no longer generating/)

    const tripSnap = await tripRef.get()
    expect(tripSnap.data()?.planMeta.status).toBe('idle')
  }, 15_000)
})
