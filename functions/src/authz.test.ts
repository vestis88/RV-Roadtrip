import { getFirestore } from 'firebase-admin/firestore'
import { initializeApp } from 'firebase-admin/app'
import { beforeAll, describe, expect, it } from 'vitest'
import { createTripForUser } from './trips.js'
import { requireTripMember } from './authz.js'

const PROJECT_ID = 'demo-rv-trip-planner'

beforeAll(() => {
  initializeApp({ projectId: PROJECT_ID })
  getFirestore().settings({ ignoreUndefinedProperties: true })
})

describe('requireTripMember', () => {
  it('resolves for a genuine member', async () => {
    const { tripId } = await createTripForUser('uidAuthzMember')
    await expect(requireTripMember(tripId, 'uidAuthzMember')).resolves.toBeUndefined()
  })

  it('rejects a signed-in user who is not a member of the trip', async () => {
    const { tripId } = await createTripForUser('uidAuthzOwner')
    await expect(requireTripMember(tripId, 'uidAuthzStranger')).rejects.toThrow(
      'Not a member of this trip',
    )
  })

  it('rejects for a trip that does not exist, without distinguishing it from a permission failure', async () => {
    await expect(requireTripMember('nonexistent-trip', 'uidAuthzAnyone')).rejects.toThrow(
      'Not a member of this trip',
    )
  })
})
