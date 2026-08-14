import { getFirestore } from 'firebase-admin/firestore'
import { initializeApp } from 'firebase-admin/app'
import { beforeAll, describe, expect, it } from 'vitest'
import { createTripForUser } from './trips.js'
import { STALE_PLAN_LOCK_MS } from './planLock.js'

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
    await tripRef.update({
      'planMeta.status': 'generating',
      // A genuinely running generation heartbeats this (planLock.ts); without
      // it the claim would be treated as abandoned and reclaimed.
      'planMeta.statusUpdatedAt': new Date().toISOString(),
    })

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

  // The other half of that guard: without an expiry, a run killed by its own
  // timeout (or a crash/deploy) left `planMeta.status` stuck at 'generating'
  // forever and every later generate/replan/insertRestDay/reconcile on that
  // trip was refused — unrecoverable without a manual Firestore edit. See
  // planLock.ts.
  it('reclaims a claim abandoned by a run that died without clearing it', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidCostGuardStale')
    const tripRef = db.collection('trips').doc(tripId)

    await tripRef.update({
      'planMeta.status': 'generating',
      'planMeta.statusUpdatedAt': new Date(
        Date.now() - (STALE_PLAN_LOCK_MS + 60_000),
      ).toISOString(),
    })

    const requestRef = await db.collection('planRequests').add({
      tripId,
      kind: 'full',
      status: 'pending',
    })

    // It gets past the guard and runs for real — reaching 'error' here only
    // because this sandbox has no Claude credentials, which is still proof
    // the claim was taken rather than refused up front.
    const finalRequest = await waitFor(async () => {
      const snap = await requestRef.get()
      const data = snap.data()
      return data?.status === 'error' || data?.status === 'done' ? data : undefined
    })
    expect(finalRequest.error ?? '').not.toMatch(/already in progress/)
  }, 20_000)

  // Segmented generation (2026-07-31): a chained continuation request
  // (isContinuation: true — see generatePlan.ts's runFullGeneration) must
  // NOT be rejected by this same busy guard just because the trip is
  // 'generating' — that's expected, it's the parent invocation's own claim
  // still in effect, not a competing request.
  it('lets a continuation request through while the trip is generating, unlike a fresh request', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidCostGuardContinuation')
    const tripRef = db.collection('trips').doc(tripId)
    await tripRef.update({
      'planMeta.status': 'generating',
      // A genuinely running generation heartbeats this (planLock.ts); without
      // it the claim would be treated as abandoned and reclaimed.
      'planMeta.statusUpdatedAt': new Date().toISOString(),
    })

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

  // The window the `planMeta.status` check alone cannot see, and the one
  // that destroyed two real trips (2026-08-11 via "Add a rest day here",
  // 2026-08-13 via the overnight-stop picker). A planRequest is a Firestore
  // write and generatePlan is a trigger on it, so between the write landing
  // and the trigger claiming the trip, the trip is still 'ready' — a second
  // tap lands against an idle-looking trip. Whether the old guard caught it
  // came down to when Eventarc delivered the second event: during the first
  // run it was refused, after the first run it was waved through and a
  // second Claude-costed rewrite ran against a plan that had already been
  // replaced.
  //
  // `lastRunEndedAt` in the near future is how "a run that ends after this
  // request was written" is staged deterministically here — in production
  // the ordering arises on its own, from the first run finishing while the
  // second request sits undelivered. What is being asserted is the property
  // that makes the guard closed rather than narrowed: the verdict is a
  // comparison of two fixed server timestamps, so no delivery delay can
  // change it.
  it('refuses a request that was written before the run in flight finished', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidCostGuardWindow')
    const tripRef = db.collection('trips').doc(tripId)

    await tripRef.update({
      // Deliberately NOT busy: this is exactly what the second tap saw.
      'planMeta.status': 'ready',
      'planMeta.lastRunEndedAt': new Date(Date.now() + 60_000).toISOString(),
    })

    const requestRef = await db.collection('planRequests').add({
      tripId,
      kind: 'replan',
      status: 'pending',
      replanContext: {
        currentLocation: { lat: 55.6761, lng: 12.5683 },
        today: '2026-08-14',
        completedRefPaths: [],
        remainingEndDate: '2026-08-17',
        remainingEndPoint: { name: 'Copenhagen', lat: 55.6761, lng: 12.5683 },
        changeRequestText: 'Change the overnight stop for Day 2',
        lockedDayIds: [],
      },
    })

    const finalRequest = await waitFor(async () => {
      const snap = await requestRef.get()
      const data = snap.data()
      return data?.status === 'error' ? data : undefined
    })

    expect(finalRequest.error).toMatch(/refused as a duplicate/)

    // A refused request must leave the trip completely alone — it never ran,
    // so it must neither disturb a run in flight nor move the watermark that
    // later requests are judged against.
    const tripSnap = await tripRef.get()
    expect(tripSnap.data()?.planMeta.status).toBe('ready')
  }, 15_000)

  // The same guarantee stated as the traveler experiences it, without
  // staging any timestamps: two taps in one burst, and whatever the delivery
  // order, only one of them is ever allowed to rewrite the trip.
  it('lets only one of two requests submitted in the same burst run', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidCostGuardBurst')
    const requests = db.collection('planRequests')
    const body = { tripId, kind: 'full' as const, status: 'pending' }

    const [first, second] = await Promise.all([
      requests.add(body),
      requests.add(body),
    ])

    const outcomes = await waitFor(async () => {
      const snaps = await Promise.all([first.get(), second.get()])
      const done = snaps.every((snap) => snap.data()?.status !== 'pending')
      return done ? snaps.map((snap) => snap.data()?.error ?? '') : undefined
    }, 25_000)

    // One is turned away by the guard — either because the other was still
    // running ('already in progress') or because it was written before the
    // other finished ('refused as a duplicate'); which one depends on
    // delivery timing and does not matter. The other gets through to the
    // real pipeline and fails there for want of Claude credentials in this
    // sandbox, which is what proves it was allowed to run.
    const refused = outcomes.filter((error) =>
      /already in progress|refused as a duplicate/.test(error),
    )
    expect(refused).toHaveLength(1)
  }, 30_000)

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
