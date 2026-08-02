import { getFirestore } from 'firebase-admin/firestore'
import { initializeApp } from 'firebase-admin/app'
import { beforeAll, describe, expect, it } from 'vitest'
import { createTripForUser, joinTripByCode } from './trips.js'
import { deleteTripForUser } from './deleteTrip.js'
import {
  createShareTokenForTrip,
  resolveShareToken,
} from './shareTokens.js'

const PROJECT_ID = 'demo-rv-trip-planner'

beforeAll(() => {
  initializeApp({ projectId: PROJECT_ID })
  getFirestore().settings({ ignoreUndefinedProperties: true })
})

describe('deleteTripForUser', () => {
  it('deletes the trip doc, its subcollections, the share code, and every member\'s reverse index', async () => {
    const db = getFirestore()
    const { tripId, shareCode } = await createTripForUser('uidDeleteA')
    await joinTripByCode('uidDeleteB', shareCode)
    await db
      .collection('trips')
      .doc(tripId)
      .collection('corridorStops')
      .add({ name: 'x', lat: 1, lng: 1, status: 'locked', linkedDayIds: [] })

    await deleteTripForUser('uidDeleteA', tripId)

    expect((await db.collection('trips').doc(tripId).get()).exists).toBe(false)
    expect(
      (await db.collection('trips').doc(tripId).collection('corridorStops').get())
        .empty,
    ).toBe(true)
    expect((await db.collection('shareCodes').doc(shareCode).get()).exists).toBe(
      false,
    )
    expect(
      (
        await db.collection('users').doc('uidDeleteA').collection('trips').doc(tripId).get()
      ).exists,
    ).toBe(false)
    expect(
      (
        await db.collection('users').doc('uidDeleteB').collection('trips').doc(tripId).get()
      ).exists,
    ).toBe(false)
  })

  it('takes the family view link down with the trip', async () => {
    const { tripId } = await createTripForUser('uidDeleteShareLink')
    const { token } = await createShareTokenForTrip('uidDeleteShareLink', tripId)

    await deleteTripForUser('uidDeleteShareLink', tripId)

    await expect(resolveShareToken(token)).resolves.toBeNull()
  })

  it('rejects a non-member', async () => {
    const { tripId } = await createTripForUser('uidDeleteOwner')
    await expect(deleteTripForUser('uidDeleteStranger', tripId)).rejects.toThrow()
    expect((await getFirestore().collection('trips').doc(tripId).get()).exists).toBe(
      true,
    )
  })

  it('throws not-found for a trip that does not exist', async () => {
    await expect(deleteTripForUser('uidX', 'nonexistent-trip')).rejects.toThrow()
  })
})
