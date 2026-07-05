import { readFileSync } from 'node:fs'
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import { doc, getDoc } from 'firebase/firestore'
import { initializeApp } from 'firebase-admin/app'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTripForUser, joinTripByCode } from './trips.js'

const PROJECT_ID = 'demo-rv-trip-planner'

let testEnv: RulesTestEnvironment

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

    const aliceDb = testEnv.authenticatedContext('uidA').firestore()
    const bobDb = testEnv.authenticatedContext('uidB').firestore()
    const strangerDb = testEnv.authenticatedContext('uidC').firestore()

    await assertSucceeds(getDoc(doc(aliceDb, 'trips', tripId)))
    await assertSucceeds(getDoc(doc(bobDb, 'trips', tripId)))
    await assertFails(getDoc(doc(strangerDb, 'trips', tripId)))
  })

  it('rejects an invalid share code', async () => {
    await testEnv.clearFirestore()
    await expect(joinTripByCode('uidX', 'ZZZZZZ')).rejects.toThrow()
  })
})
