import { getFirestore } from 'firebase-admin/firestore'
import { initializeApp } from 'firebase-admin/app'
import { beforeAll, describe, expect, it } from 'vitest'
import { createTripForUser, joinTripByCode } from './trips.js'
import { mergeTripsForUid } from './mergeTrips.js'

const PROJECT_ID = 'demo-rv-trip-planner'
const AUTH_EMULATOR_HOST = '127.0.0.1:9099'

beforeAll(() => {
  initializeApp({ projectId: PROJECT_ID })
  getFirestore().settings({ ignoreUndefinedProperties: true })
})

/**
 * Mints a real ID token for a brand-new user via the Auth emulator's own
 * REST API — mergeTripsForUid calls the real `verifyIdToken`, so a stubbed
 * token (or just a bare uid string) wouldn't exercise the actual check this
 * function exists for: proving the caller controlled `oldUid` before
 * trusting it enough to graft trip access onto a different uid.
 */
async function mintIdToken(): Promise<{ uid: string; idToken: string }> {
  const response = await fetch(
    `http://${AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ returnSecureToken: true }),
    },
  )
  const data = (await response.json()) as { idToken: string; localId: string }
  return { uid: data.localId, idToken: data.idToken }
}

describe('mergeTripsForUid', () => {
  it('carries every trip the old identity belonged to across to the new uid', async () => {
    const { uid: oldUid, idToken: oldIdToken } = await mintIdToken()
    const { uid: newUid } = await mintIdToken()

    await createTripForUser(oldUid)
    const { shareCode } = await createTripForUser('someoneElse')
    await joinTripByCode(oldUid, shareCode)
    const tripsSnap = await getFirestore()
      .collection('users')
      .doc(oldUid)
      .collection('trips')
      .get()
    expect(tripsSnap.docs.map((d) => d.id).sort()).toHaveLength(2)

    const result = await mergeTripsForUid(newUid, oldUid, oldIdToken)

    expect(result.mergedTripIds.sort()).toEqual(
      tripsSnap.docs.map((d) => d.id).sort(),
    )

    const newUserTrips = await getFirestore()
      .collection('users')
      .doc(newUid)
      .collection('trips')
      .get()
    expect(newUserTrips.docs.map((d) => d.id).sort()).toEqual(
      result.mergedTripIds.sort(),
    )

    for (const tripId of result.mergedTripIds) {
      const memberDoc = await getFirestore()
        .collection('trips')
        .doc(tripId)
        .collection('members')
        .doc(newUid)
        .get()
      expect(memberDoc.exists).toBe(true)
    }
  })

  it('rejects an oldIdToken that does not actually belong to oldUid', async () => {
    const { idToken } = await mintIdToken()
    await expect(
      mergeTripsForUid('newUid', 'someone-elses-uid', idToken),
    ).rejects.toThrow()
  })

  it('is a no-op when the old identity had no trips', async () => {
    const { uid: oldUid, idToken: oldIdToken } = await mintIdToken()
    const { uid: newUid } = await mintIdToken()

    const result = await mergeTripsForUid(newUid, oldUid, oldIdToken)

    expect(result.mergedTripIds).toEqual([])
  })

  it('is a no-op when oldUid and newUid are the same', async () => {
    const { uid, idToken } = await mintIdToken()
    await createTripForUser(uid)

    const result = await mergeTripsForUid(uid, uid, idToken)

    expect(result.mergedTripIds).toEqual([])
  })
})
