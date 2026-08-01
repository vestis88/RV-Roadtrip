import { getFirestore } from 'firebase-admin/firestore'
import { initializeApp } from 'firebase-admin/app'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createTripForUser } from './trips.js'

const PROJECT_ID = 'demo-rv-trip-planner'

beforeAll(() => {
  initializeApp({ projectId: PROJECT_ID })
  getFirestore().settings({ ignoreUndefinedProperties: true })
})

const generateCountryGuideMock = vi.fn()
vi.mock('./prompts/countryGuide.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./prompts/countryGuide.js')>()
  return {
    ...actual,
    generateCountryGuide: (...args: unknown[]) => generateCountryGuideMock(...args),
  }
})

const FIXTURE_GUIDE = {
  countryCode: 'NO',
  vignetteRequired: false,
  freeCampingRules: 'Allemannsretten allows wild camping widely.',
  drivingNotes: 'Drive on the right.',
  emergencyNumber: '112',
}

describe('refreshCountryGuideForTrip', () => {
  it('writes the generated guide under trips/{tripId}/countries/{countryCode}', async () => {
    const { tripId } = await createTripForUser('uidCountryGuideA')
    generateCountryGuideMock.mockReset().mockResolvedValue(FIXTURE_GUIDE)

    const { refreshCountryGuideForTrip } = await import('./countryGuideCallable.js')
    await refreshCountryGuideForTrip(tripId, 'NO')

    const snap = await getFirestore()
      .collection('trips')
      .doc(tripId)
      .collection('countries')
      .doc('NO')
      .get()
    expect(snap.data()).toMatchObject(FIXTURE_GUIDE)
  })

  it('throws not-found for a trip that does not exist', async () => {
    const { refreshCountryGuideForTrip } = await import('./countryGuideCallable.js')
    await expect(
      refreshCountryGuideForTrip('nonexistent-trip', 'NO'),
    ).rejects.toThrow()
  })
})

describe('refreshCountryGuide callable', () => {
  it('rejects a signed-in caller who is not a member of the trip', async () => {
    const { tripId } = await createTripForUser('uidCountryGuideCallableOwner')
    generateCountryGuideMock.mockReset().mockResolvedValue(FIXTURE_GUIDE)
    const { refreshCountryGuide } = await import('./countryGuideCallable.js')
    await expect(
      refreshCountryGuide.run({
        data: { tripId, countryCode: 'NO' },
        auth: { uid: 'uidCountryGuideCallableStranger' },
      } as never),
    ).rejects.toThrow('Not a member of this trip')
    expect(generateCountryGuideMock).not.toHaveBeenCalled()
  })
})
