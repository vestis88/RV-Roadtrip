import { initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { beforeAll, describe, expect, it } from 'vitest'
import { createTripForUser } from './trips.js'
import {
  SHARE_TOKENS_COLLECTION,
  activeShareTokenForTrip,
  createShareTokenForTrip,
  resolveShareToken,
  revokeShareTokensForTrip,
} from './shareTokens.js'

const PROJECT_ID = 'demo-rv-trip-planner'

beforeAll(() => {
  initializeApp({ projectId: PROJECT_ID })
  getFirestore().settings({ ignoreUndefinedProperties: true })
})

describe('createShareTokenForTrip', () => {
  it('mints an unguessable token and resolves it back to the trip', async () => {
    const { tripId } = await createTripForUser('uidShareTokenA')

    const { token } = await createShareTokenForTrip('uidShareTokenA', tripId)

    expect(token.length).toBeGreaterThanOrEqual(32)
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    await expect(resolveShareToken(token)).resolves.toBe(tripId)
  })

  it('is not the 6-character editor share code', async () => {
    const { tripId, shareCode } = await createTripForUser('uidShareTokenCode')
    const { token } = await createShareTokenForTrip('uidShareTokenCode', tripId)
    expect(token).not.toBe(shareCode)
    expect(token.length).toBeGreaterThan(shareCode.length)
  })

  it('returns the existing link instead of minting a second one', async () => {
    const { tripId } = await createTripForUser('uidShareTokenB')

    const first = await createShareTokenForTrip('uidShareTokenB', tripId)
    const second = await createShareTokenForTrip('uidShareTokenB', tripId)

    expect(second.token).toBe(first.token)
    const stored = await getFirestore()
      .collection(SHARE_TOKENS_COLLECTION)
      .where('tripId', '==', tripId)
      .get()
    expect(stored.size).toBe(1)
  })

  it('rejects someone who is not a member of the trip', async () => {
    const { tripId } = await createTripForUser('uidShareTokenOwner')
    await expect(
      createShareTokenForTrip('uidShareTokenStranger', tripId),
    ).rejects.toThrow('Not a member of this trip')
  })
})

describe('revokeShareTokensForTrip', () => {
  it('kills the live link and leaves the trip with none', async () => {
    const { tripId } = await createTripForUser('uidShareTokenC')
    const { token } = await createShareTokenForTrip('uidShareTokenC', tripId)

    const { revoked } = await revokeShareTokensForTrip('uidShareTokenC', tripId)

    expect(revoked).toBe(1)
    await expect(resolveShareToken(token)).resolves.toBeNull()
    await expect(activeShareTokenForTrip(tripId)).resolves.toBeNull()
  })

  it('leaves the revoked token on record rather than deleting it', async () => {
    const { tripId } = await createTripForUser('uidShareTokenD')
    const { token } = await createShareTokenForTrip('uidShareTokenD', tripId)
    await revokeShareTokensForTrip('uidShareTokenD', tripId)

    const snap = await getFirestore()
      .collection(SHARE_TOKENS_COLLECTION)
      .doc(token)
      .get()
    expect(snap.exists).toBe(true)
    expect(snap.data()?.revokedAt).toBeTruthy()
  })

  it('regenerating produces a different token and the old one stays dead', async () => {
    const { tripId } = await createTripForUser('uidShareTokenE')
    const first = await createShareTokenForTrip('uidShareTokenE', tripId)
    await revokeShareTokensForTrip('uidShareTokenE', tripId)

    const second = await createShareTokenForTrip('uidShareTokenE', tripId)

    expect(second.token).not.toBe(first.token)
    await expect(resolveShareToken(first.token)).resolves.toBeNull()
    await expect(resolveShareToken(second.token)).resolves.toBe(tripId)
  })

  it('rejects someone who is not a member of the trip', async () => {
    const { tripId } = await createTripForUser('uidShareTokenRevokeOwner')
    await createShareTokenForTrip('uidShareTokenRevokeOwner', tripId)
    await expect(
      revokeShareTokensForTrip('uidShareTokenRevokeStranger', tripId),
    ).rejects.toThrow('Not a member of this trip')
  })
})

describe('resolveShareToken', () => {
  it('answers null for anything that is not a live token, without throwing', async () => {
    await expect(resolveShareToken('')).resolves.toBeNull()
    await expect(resolveShareToken('short')).resolves.toBeNull()
    // A document ID is a path segment: a token containing a slash would
    // otherwise address some other collection entirely.
    await expect(
      resolveShareToken('trips/someTripId/days/someDayId/aaaaaaaaaaaaaaaa'),
    ).resolves.toBeNull()
    await expect(
      resolveShareToken('a'.repeat(43)),
    ).resolves.toBeNull()
  })
})
