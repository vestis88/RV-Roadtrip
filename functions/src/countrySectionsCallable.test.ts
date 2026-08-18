import { initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_COUNTRY_BRIEF_SECTIONS,
  countryGuideSectionDocId,
  type CountryGuideSection,
  type Vehicle,
} from '@rv/shared'
import { createTripForUser } from './trips.js'

const PROJECT_ID = 'demo-rv-trip-planner'

beforeAll(() => {
  initializeApp({ projectId: PROJECT_ID })
  getFirestore().settings({ ignoreUndefinedProperties: true })
})

const generateCountrySectionMock = vi.fn()
vi.mock('./prompts/countrySection.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./prompts/countrySection.js')>()
  return {
    ...actual,
    generateCountrySection: (...args: unknown[]) =>
      generateCountrySectionMock(...args),
  }
})

beforeEach(() => {
  generateCountrySectionMock.mockReset().mockResolvedValue({
    items: ['A finding.'],
    sources: ['https://example.test'],
  })
})

async function vehicleOf(tripId: string): Promise<Vehicle> {
  const snap = await getFirestore().collection('trips').doc(tripId).get()
  return snap.data()!.settings.vehicle as Vehicle
}

describe('researchCountrySectionsForTrip', () => {
  it('researches only the sections asked for', async () => {
    const { tripId } = await createTripForUser('uidCountryOne')
    const { researchCountrySectionsForTrip } = await import(
      './countrySectionsCallable.js'
    )

    const result = await researchCountrySectionsForTrip({
      tripId,
      uid: 'uidCountryOne',
      countryCode: 'NO',
      countryName: 'Norway',
      sectionIds: ['camping-rules'],
    })

    expect(result).toEqual({
      researched: ['camping-rules'],
      failed: [],
      failureReasons: {},
    })
    // The whole point: one section asked for is one Claude call made, not
    // six. This is what "add one item without re-running the rest" means.
    expect(generateCountrySectionMock).toHaveBeenCalledTimes(1)
  })

  it('stores each section outside the trip, keyed so another trip finds it', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidCountryShared')
    const { researchCountrySectionsForTrip } = await import(
      './countrySectionsCallable.js'
    )
    await researchCountrySectionsForTrip({
      tripId,
      uid: 'uidCountryShared',
      countryCode: 'SE',
      countryName: 'Sweden',
      sectionIds: ['camping-rules'],
    })

    const section = DEFAULT_COUNTRY_BRIEF_SECTIONS.find(
      (s) => s.id === 'camping-rules',
    )!
    const docId = countryGuideSectionDocId({
      countryCode: 'SE',
      section,
      vehicle: await vehicleOf(tripId),
    })
    const snap = await db.collection('countryGuideSections').doc(docId).get()
    expect(snap.exists).toBe(true)
    expect(snap.data() as CountryGuideSection).toMatchObject({
      countryCode: 'SE',
      sectionId: 'camping-rules',
      items: ['A finding.'],
    })

    // A second, unrelated trip lands on the same document — no second call.
    const { tripId: otherTripId } = await createTripForUser('uidCountryShared2')
    expect(
      countryGuideSectionDocId({
        countryCode: 'SE',
        section,
        vehicle: await vehicleOf(otherTripId),
      }),
    ).toBe(docId)
  })

  it('reads the brief from the traveler’s account, so a custom section is researchable', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidCountryCustom')
    await db
      .collection('users')
      .doc('uidCountryCustom')
      .collection('preferences')
      .doc('countryBrief')
      .set({
        sections: [
          {
            id: 'drinking-water',
            title: 'Drinking water',
            brief: 'Where to refill fresh drinking water.',
            dependsOnVehicle: false,
          },
        ],
        updatedAt: new Date().toISOString(),
      })

    const { researchCountrySectionsForTrip } = await import(
      './countrySectionsCallable.js'
    )
    const result = await researchCountrySectionsForTrip({
      tripId,
      uid: 'uidCountryCustom',
      countryCode: 'NO',
      countryName: 'Norway',
      sectionIds: ['drinking-water'],
    })

    expect(result.researched).toEqual(['drinking-water'])
    expect(generateCountrySectionMock.mock.calls[0][0]).toMatchObject({
      section: { id: 'drinking-water' },
    })
  })

  it('rejects a section that is not in the traveler’s brief', async () => {
    const { tripId } = await createTripForUser('uidCountryUnknown')
    const { researchCountrySectionsForTrip } = await import(
      './countrySectionsCallable.js'
    )

    await expect(
      researchCountrySectionsForTrip({
        tripId,
        uid: 'uidCountryUnknown',
        countryCode: 'NO',
        countryName: 'Norway',
        sectionIds: ['not-a-section'],
      }),
    ).rejects.toThrow('research list')
    expect(generateCountrySectionMock).not.toHaveBeenCalled()
  })

  // One bad section must not cost the traveler the ones that worked — each
  // is a separate Claude call and a separate document, so there is nothing
  // to roll back.
  it('keeps the sections that succeeded when one fails', async () => {
    const db = getFirestore()
    const { tripId } = await createTripForUser('uidCountryPartial')
    generateCountrySectionMock.mockImplementation(
      (input: { section: { id: string } }) =>
        input.section.id === 'lpg-info'
          ? Promise.reject(new Error('web search exploded'))
          : Promise.resolve({ items: ['A finding.'], sources: [] }),
    )

    const { researchCountrySectionsForTrip } = await import(
      './countrySectionsCallable.js'
    )
    const result = await researchCountrySectionsForTrip({
      tripId,
      uid: 'uidCountryPartial',
      countryCode: 'DK',
      countryName: 'Denmark',
      sectionIds: ['camping-rules', 'lpg-info'],
    })

    expect(result.researched).toEqual(['camping-rules'])
    expect(result.failed).toEqual(['lpg-info'])
    // And WHY, which used to be logged here and then dropped — leaving the
    // screen able to count failures and say nothing else about them.
    expect(result.failureReasons['lpg-info']).toContain('web search exploded')
    expect(result.failureReasons).not.toHaveProperty('camping-rules')
    const stored = await db
      .collection('countryGuideSections')
      .where('countryCode', '==', 'DK')
      .get()
    expect(stored.docs.map((d) => (d.data() as CountryGuideSection).sectionId)).toEqual([
      'camping-rules',
    ])
  })

  it('falls back to the built-in brief for a traveler who has never edited it', async () => {
    const { tripId } = await createTripForUser('uidCountryDefaults')
    const { loadCountryBrief } = await import('./countrySectionsCallable.js')
    expect(await loadCountryBrief('uidCountryDefaults')).toEqual(
      DEFAULT_COUNTRY_BRIEF_SECTIONS,
    )
    expect(tripId).toBeTruthy()
  })
})
