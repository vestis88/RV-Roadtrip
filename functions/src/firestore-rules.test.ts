import { readFileSync } from 'node:fs'
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing'
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
} from 'firebase/firestore'
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest'

const PROJECT_ID = 'demo-rv-trip-planner-rules'
const TRIP_ID = 'trip1'
const MEMBER_UID = 'memberUid'
const OTHER_MEMBER_UID = 'otherMemberUid'
const STRANGER_UID = 'strangerUid'

let testEnv: RulesTestEnvironment

async function seedTrip() {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore()
    await setDoc(doc(db, 'trips', TRIP_ID), { meta: { name: 'Seed trip' } })
    await setDoc(doc(db, 'trips', TRIP_ID, 'members', MEMBER_UID), {
      joinedAt: '2026-01-01T00:00:00Z',
    })
    await setDoc(doc(db, 'trips', TRIP_ID, 'members', OTHER_MEMBER_UID), {
      joinedAt: '2026-01-01T00:00:00Z',
    })
    await setDoc(doc(db, 'trips', TRIP_ID, 'days', 'day1'), {
      index: 0,
      summary: 'Day one',
    })
    await setDoc(doc(db, 'shareCodes', 'AB12CD'), { tripId: TRIP_ID })
    await setDoc(doc(db, 'users', MEMBER_UID, 'trips', TRIP_ID), {
      joinedAt: '2026-01-01T00:00:00Z',
    })
  })
}

beforeEach(async () => {
  await testEnv.clearFirestore()
  await seedTrip()
})

beforeAll(async () => {
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

describe('trips/{tripId}', () => {
  it('lets a member read the trip', async () => {
    const db = testEnv.authenticatedContext(MEMBER_UID).firestore()
    await assertSucceeds(getDoc(doc(db, 'trips', TRIP_ID)))
  })

  it('lets a member update the trip', async () => {
    const db = testEnv.authenticatedContext(MEMBER_UID).firestore()
    await assertSucceeds(
      updateDoc(doc(db, 'trips', TRIP_ID), { 'meta.name': 'Renamed trip' }),
    )
  })

  it('denies a stranger reading the trip', async () => {
    const db = testEnv.authenticatedContext(STRANGER_UID).firestore()
    await assertFails(getDoc(doc(db, 'trips', TRIP_ID)))
  })

  it('denies a stranger updating the trip', async () => {
    const db = testEnv.authenticatedContext(STRANGER_UID).firestore()
    await assertFails(
      updateDoc(doc(db, 'trips', TRIP_ID), { 'meta.name': 'Hijacked' }),
    )
  })

  it('denies an unauthenticated client reading the trip', async () => {
    const db = testEnv.unauthenticatedContext().firestore()
    await assertFails(getDoc(doc(db, 'trips', TRIP_ID)))
  })

  it('denies direct client creation of a trip (must go through createTrip)', async () => {
    const db = testEnv.authenticatedContext(STRANGER_UID).firestore()
    await assertFails(setDoc(doc(db, 'trips', 'trip2'), { meta: {} }))
  })

  it('denies deleting the trip document', async () => {
    const db = testEnv.authenticatedContext(MEMBER_UID).firestore()
    await assertFails(deleteDoc(doc(db, 'trips', TRIP_ID)))
  })
})

describe('trips/{tripId}/days (and other subcollections)', () => {
  it('lets a member create, read, update, and delete a day doc', async () => {
    const db = testEnv.authenticatedContext(MEMBER_UID).firestore()
    const dayRef = doc(db, 'trips', TRIP_ID, 'days', 'day2')

    await assertSucceeds(setDoc(dayRef, { index: 1, summary: 'Day two' }))
    await assertSucceeds(getDoc(dayRef))
    await assertSucceeds(updateDoc(dayRef, { summary: 'Updated' }))
    await assertSucceeds(deleteDoc(dayRef))
  })

  it('lets any member of the trip write, not just the creator', async () => {
    const db = testEnv.authenticatedContext(OTHER_MEMBER_UID).firestore()
    await assertSucceeds(
      updateDoc(doc(db, 'trips', TRIP_ID, 'days', 'day1'), {
        summary: 'Edited by the other member',
      }),
    )
  })

  it('denies a stranger reading or writing a day doc', async () => {
    const db = testEnv.authenticatedContext(STRANGER_UID).firestore()
    const dayRef = doc(db, 'trips', TRIP_ID, 'days', 'day1')
    await assertFails(getDoc(dayRef))
    await assertFails(updateDoc(dayRef, { summary: 'Hijacked' }))
  })
})

describe('trips/{tripId}/corridorStops', () => {
  it('lets a member create, read, update, and delete a corridor stop', async () => {
    const db = testEnv.authenticatedContext(MEMBER_UID).firestore()
    const stopRef = doc(db, 'trips', TRIP_ID, 'corridorStops', 'stop1')

    await assertSucceeds(
      setDoc(stopRef, {
        name: 'Otta',
        lat: 61.77,
        lng: 9.54,
        country: 'NO',
        status: 'committed',
        linkedDayIds: ['day1'],
      }),
    )
    await assertSucceeds(getDoc(stopRef))
    await assertSucceeds(updateDoc(stopRef, { status: 'locked' }))
    await assertSucceeds(deleteDoc(stopRef))
  })

  it('denies a stranger reading or writing a corridor stop', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(
        doc(context.firestore(), 'trips', TRIP_ID, 'corridorStops', 'stop1'),
        {
          name: 'Otta',
          lat: 61.77,
          lng: 9.54,
          country: 'NO',
          status: 'committed',
          linkedDayIds: ['day1'],
        },
      )
    })
    const db = testEnv.authenticatedContext(STRANGER_UID).firestore()
    const stopRef = doc(db, 'trips', TRIP_ID, 'corridorStops', 'stop1')
    await assertFails(getDoc(stopRef))
    await assertFails(updateDoc(stopRef, { status: 'locked' }))
  })
})

describe('trips/{tripId}/members', () => {
  it('lets a member read the members list', async () => {
    const db = testEnv.authenticatedContext(MEMBER_UID).firestore()
    await assertSucceeds(getDocs(collection(db, 'trips', TRIP_ID, 'members')))
  })

  it('denies a stranger reading the members list', async () => {
    const db = testEnv.authenticatedContext(STRANGER_UID).firestore()
    await assertFails(getDocs(collection(db, 'trips', TRIP_ID, 'members')))
  })

  it('denies a member adding themselves directly (must go through joinTrip)', async () => {
    const db = testEnv.authenticatedContext(STRANGER_UID).firestore()
    await assertFails(
      setDoc(doc(db, 'trips', TRIP_ID, 'members', STRANGER_UID), {
        joinedAt: '2026-01-01T00:00:00Z',
      }),
    )
  })

  it("denies even an existing member overwriting another member's doc", async () => {
    const db = testEnv.authenticatedContext(MEMBER_UID).firestore()
    await assertFails(
      setDoc(doc(db, 'trips', TRIP_ID, 'members', OTHER_MEMBER_UID), {
        joinedAt: 'tampered',
      }),
    )
  })
})

describe('users/{uid}/trips', () => {
  it('lets a user read their own trip list', async () => {
    const db = testEnv.authenticatedContext(MEMBER_UID).firestore()
    await assertSucceeds(
      getDoc(doc(db, 'users', MEMBER_UID, 'trips', TRIP_ID)),
    )
  })

  it("denies reading another user's trip list", async () => {
    const db = testEnv.authenticatedContext(STRANGER_UID).firestore()
    await assertFails(getDoc(doc(db, 'users', MEMBER_UID, 'trips', TRIP_ID)))
  })

  it('denies any client write (must go through createTrip/joinTrip)', async () => {
    const db = testEnv.authenticatedContext(MEMBER_UID).firestore()
    await assertFails(
      setDoc(doc(db, 'users', MEMBER_UID, 'trips', 'someOtherTripId'), {
        joinedAt: '2026-01-01T00:00:00Z',
      }),
    )
  })
})

describe('shareCodes/{code}', () => {
  it('denies any client read (only Cloud Functions resolve codes)', async () => {
    const db = testEnv.authenticatedContext(MEMBER_UID).firestore()
    await assertFails(getDoc(doc(db, 'shareCodes', 'AB12CD')))
  })

  it('denies any client write', async () => {
    const db = testEnv.authenticatedContext(MEMBER_UID).firestore()
    await assertFails(
      setDoc(doc(db, 'shareCodes', 'ZZ99ZZ'), { tripId: TRIP_ID }),
    )
  })
})

describe('planRequests/{requestId}', () => {
  it('lets any authenticated user create a plan request', async () => {
    const db = testEnv.authenticatedContext(STRANGER_UID).firestore()
    await assertSucceeds(
      setDoc(doc(db, 'planRequests', 'req1'), {
        tripId: TRIP_ID,
        kind: 'full',
        status: 'pending',
      }),
    )
  })

  it('denies an unauthenticated client creating a plan request', async () => {
    const db = testEnv.unauthenticatedContext().firestore()
    await assertFails(
      setDoc(doc(db, 'planRequests', 'req2'), {
        tripId: TRIP_ID,
        kind: 'full',
        status: 'pending',
      }),
    )
  })

  it('denies updating or deleting a plan request', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), 'planRequests', 'req3'), {
        tripId: TRIP_ID,
        kind: 'full',
        status: 'pending',
      })
    })
    const db = testEnv.authenticatedContext(MEMBER_UID).firestore()
    await assertFails(
      updateDoc(doc(db, 'planRequests', 'req3'), { status: 'error' }),
    )
    await assertFails(deleteDoc(doc(db, 'planRequests', 'req3')))
  })
})
