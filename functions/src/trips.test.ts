import { readFileSync } from 'node:fs'
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import { collection, doc, getDoc, getDocs, setDoc } from 'firebase/firestore'
import { initializeApp } from 'firebase-admin/app'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTripForUser, joinTripByCode } from './trips.js'

const PROJECT_ID = 'demo-rv-trip-planner'

let testEnv: RulesTestEnvironment

// These read through firestore.rules, which since the login gate requires the
// `access` claim on top of trip membership — see accessControl.ts. What's
// under test here is membership, so every context carries the claim; the
// gate itself is covered in firestore-rules.test.ts.
function authedDb(uid: string) {
  return testEnv.authenticatedContext(uid, { access: true }).firestore()
}

beforeAll(async () => {
  initializeApp({ projectId: PROJECT_ID })
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync('../firestore.rules', 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  })
})

afterAll(async () => {
  await testEnv.cleanup()
})

describe('createTrip + joinTrip', () => {
  it('lets the creator and a joiner read the trip, but rejects a stranger', async () => {
    await testEnv.clearFirestore()

    const { tripId, shareCode } = await createTripForUser('uidA')
    await joinTripByCode('uidB', shareCode)

    const aliceDb = authedDb('uidA')
    const bobDb = authedDb('uidB')
    const strangerDb = authedDb('uidC')

    await assertSucceeds(getDoc(doc(aliceDb, 'trips', tripId)))
    await assertSucceeds(getDoc(doc(bobDb, 'trips', tripId)))
    await assertFails(getDoc(doc(strangerDb, 'trips', tripId)))
  })

  it('rejects an invalid share code', async () => {
    await testEnv.clearFirestore()
    await expect(joinTripByCode('uidX', 'ZZZZZZ')).rejects.toThrow()
  })
})

describe('users/{uid}/trips reverse index', () => {
  it('creating a trip adds it to the creator\'s own trip list, readable only by them', async () => {
    await testEnv.clearFirestore()

    const { tripId } = await createTripForUser('uidA')

    const aliceDb = authedDb('uidA')
    const strangerDb = authedDb('uidC')

    const aliceIndex = await getDocs(collection(aliceDb, 'users', 'uidA', 'trips'))
    expect(aliceIndex.docs.map((d) => d.id)).toEqual([tripId])

    await assertSucceeds(getDoc(doc(aliceDb, 'users', 'uidA', 'trips', tripId)))
    await assertFails(getDoc(doc(strangerDb, 'users', 'uidA', 'trips', tripId)))
  })

  it("joining by code adds the trip to the joiner's own list too, without touching the creator's", async () => {
    await testEnv.clearFirestore()

    const { tripId, shareCode } = await createTripForUser('uidA')
    await joinTripByCode('uidB', shareCode)

    const bobDb = authedDb('uidB')
    const bobIndex = await getDocs(collection(bobDb, 'users', 'uidB', 'trips'))
    expect(bobIndex.docs.map((d) => d.id)).toEqual([tripId])

    const aliceDb = authedDb('uidA')
    const aliceIndex = await getDocs(collection(aliceDb, 'users', 'uidA', 'trips'))
    expect(aliceIndex.docs.map((d) => d.id)).toEqual([tripId])
  })

  it('a second trip accumulates in the list rather than replacing the first', async () => {
    await testEnv.clearFirestore()

    const { tripId: firstTripId } = await createTripForUser('uidA')
    const { tripId: secondTripId } = await createTripForUser('uidA')

    const aliceDb = authedDb('uidA')
    const aliceIndex = await getDocs(collection(aliceDb, 'users', 'uidA', 'trips'))
    expect(new Set(aliceIndex.docs.map((d) => d.id))).toEqual(
      new Set([firstTripId, secondTripId]),
    )
  })

  it('a client cannot write to the index directly (must go through createTrip/joinTrip)', async () => {
    await testEnv.clearFirestore()
    const aliceDb = authedDb('uidA')
    await assertFails(
      setDoc(doc(aliceDb, 'users', 'uidA', 'trips', 'someTripId'), {
        joinedAt: '2026-01-01T00:00:00Z',
      }),
    )
  })
})
