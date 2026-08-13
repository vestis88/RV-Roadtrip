import { getFirestore } from 'firebase-admin/firestore'
import { initializeApp } from 'firebase-admin/app'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { FREE_CAMPING_SECTION_ID } from '@rv/shared'
import type { CountryGuideSection, OvernightStopCandidate, TripDay } from '@rv/shared'
import { createTripForUser } from './trips.js'
import { COUNTRY_GUIDE_SECTIONS_COLLECTION } from './countryGuideSections.js'
import type { OsmOvernightPlace } from './overpassApi.js'

const PROJECT_ID = 'demo-rv-trip-planner'

beforeAll(() => {
  initializeApp({ projectId: PROJECT_ID })
  getFirestore().settings({ ignoreUndefinedProperties: true })
})

// Only the two network sources are mocked. The OSM ranking/conversion
// helpers (nearestOsmPlaces, osmPlaceToCandidate) stay real, because what
// this file is checking is which of a day's genuine options gets committed —
// stubbing those out would leave it checking its own fixtures.
const findNearbyCampsitesMock = vi.fn()
vi.mock('./placesApi.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./placesApi.js')>()
  return {
    ...actual,
    findNearbyCampsites: (...args: unknown[]) => findNearbyCampsitesMock(...args),
  }
})

const searchOsmMock = vi.fn()
vi.mock('./overpassApi.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./overpassApi.js')>()
  return {
    ...actual,
    searchOvernightOsmAlongRoute: (...args: unknown[]) => searchOsmMock(...args),
  }
})

const TOWN = { lat: 61.1, lng: 10.5 }

const CAMPSITE: OvernightStopCandidate = {
  name: 'Lillehammer Camping',
  type: 'campsite',
  ...TOWN,
  country: 'NO',
  description: 'A campsite',
  source: 'places',
}

/** A lay-by OSM actually maps — never an invented pin in a field. */
const FREE_PARKING: OsmOvernightPlace = {
  name: 'Rasteplass Mesnali',
  kind: 'wild',
  lat: 61.12,
  lng: 10.55,
  description: 'Parking where motorhomes are explicitly allowed.',
  free: true,
  explicitStopover: false,
}

const ALLEMANNSRETTEN =
  'Allemannsretten allows camping for up to two nights on uncultivated land, at least 150m from the nearest inhabited house.'

async function seedFreeCampingRules(
  countryCode: string,
  items: string[],
): Promise<void> {
  const section: CountryGuideSection = {
    countryCode,
    sectionId: FREE_CAMPING_SECTION_ID,
    title: 'Free camping rules',
    items,
    sources: [],
    generatedAt: new Date().toISOString(),
  }
  await getFirestore()
    .collection(COUNTRY_GUIDE_SECTIONS_COLLECTION)
    .doc(`${countryCode}_${FREE_CAMPING_SECTION_ID}_test`)
    .set(section)
}

async function seedTrip(
  uid: string,
  input: {
    country: string
    offGridTolerance?: number
    /** Day types in order — one entry per night. */
    types?: TripDay['type'][]
  },
): Promise<string> {
  const { tripId } = await createTripForUser(uid)
  const db = getFirestore()
  const tripRef = db.collection('trips').doc(tripId)
  if (input.offGridTolerance !== undefined) {
    await tripRef.update({ 'settings.offGridTolerance': input.offGridTolerance })
  }
  const types = input.types ?? ['drive', 'drive', 'drive', 'drive', 'drive', 'drive']
  await Promise.all(
    types.map((type, index) => {
      const day: TripDay = {
        index,
        date: `2026-08-${String(index + 1).padStart(2, '0')}`,
        type,
        overnight: { name: 'Lillehammer', ...TOWN, country: input.country },
        summary: 'A day',
      }
      return tripRef.collection('days').doc(day.date).set(day)
    }),
  )
  return tripId
}

async function committedNights(
  tripId: string,
): Promise<{ type?: string; freeCampingRule?: string }[]> {
  const snap = await getFirestore()
    .collection('trips')
    .doc(tripId)
    .collection('days')
    .get()
  return snap.docs
    .map((doc) => doc.data() as TripDay)
    .sort((a, b) => a.index - b.index)
    .map((day) => ({
      type: day.overnight.type,
      freeCampingRule: day.overnight.freeCampingRule,
    }))
}

describe('applyOvernightOptions off-grid budget', () => {
  beforeAll(() => {
    findNearbyCampsitesMock.mockResolvedValue([CAMPSITE])
    searchOsmMock.mockResolvedValue([FREE_PARKING])
  })

  // The rule the traveler asked for: free nights in a country that allows
  // them, ended by the tanks rather than by taste. Tolerance 2 means the
  // third night has to be somewhere with facilities, then the count restarts.
  it('services the RV after the tolerated number of free nights', async () => {
    await seedFreeCampingRules('NO', [ALLEMANNSRETTEN])
    const tripId = await seedTrip('uidOffGridCadence', {
      country: 'NO',
      offGridTolerance: 2,
    })

    const { applyOvernightOptions } = await import('./overnightOptions.js')
    await applyOvernightOptions(getFirestore().collection('trips').doc(tripId))

    expect((await committedNights(tripId)).map((night) => night.type)).toEqual([
      'wild',
      'wild',
      'campsite',
      'wild',
      'wild',
      'campsite',
    ])
  })

  // Which rule permitted the night, kept with the night — this is what the
  // traveler reads at the roadside when a sign says something different.
  it('records the country rule the free night was committed on', async () => {
    await seedFreeCampingRules('NO', [ALLEMANNSRETTEN])
    const tripId = await seedTrip('uidOffGridRule', {
      country: 'NO',
      offGridTolerance: 1,
    })

    const { applyOvernightOptions } = await import('./overnightOptions.js')
    await applyOvernightOptions(getFirestore().collection('trips').doc(tripId))

    const nights = await committedNights(tripId)
    expect(nights[0].freeCampingRule).toBe(ALLEMANNSRETTEN)
    // A serviced night has no rule to explain — and must not inherit one.
    expect(nights[1].freeCampingRule).toBeUndefined()
  })

  // This pass is re-runnable by design, so a second run has to overwrite the
  // first run's verdict rather than leave "free camping is legal here" on a
  // night that is now a campsite.
  it('clears a previous run’s rule when the country turns out to prohibit it', async () => {
    await seedFreeCampingRules('SE', [ALLEMANNSRETTEN.replace('Allemannsretten', 'Allemansrätten')])
    const tripId = await seedTrip('uidOffGridRerun', {
      country: 'SE',
      offGridTolerance: 3,
      types: ['drive'],
    })
    const tripRef = getFirestore().collection('trips').doc(tripId)

    const { applyOvernightOptions } = await import('./overnightOptions.js')
    await applyOvernightOptions(tripRef)
    expect((await committedNights(tripId))[0].type).toBe('wild')

    await seedFreeCampingRules('SE', [
      'Free camping is prohibited outside designated sites.',
    ])
    await applyOvernightOptions(tripRef)

    expect(await committedNights(tripId)).toEqual([{ type: 'campsite' }])
  })

  it('never commits a free night in a country that prohibits it', async () => {
    await seedFreeCampingRules('DE', [
      'Wild camping is prohibited in Germany outside designated Stellplätze and campsites.',
    ])
    const tripId = await seedTrip('uidOffGridProhibited', {
      country: 'DE',
      offGridTolerance: 3,
      types: ['drive', 'drive'],
    })

    const { applyOvernightOptions } = await import('./overnightOptions.js')
    await applyOvernightOptions(getFirestore().collection('trips').doc(tripId))

    expect((await committedNights(tripId)).map((night) => night.type)).toEqual([
      'campsite',
      'campsite',
    ])
  })

  // A country nobody has researched is not permission — the same path as a
  // prohibition, without anyone having had to say so.
  it('never commits a free night in a country with no researched rules', async () => {
    const tripId = await seedTrip('uidOffGridUnresearched', {
      country: 'PT',
      offGridTolerance: 3,
      types: ['drive', 'drive'],
    })

    const { applyOvernightOptions } = await import('./overnightOptions.js')
    await applyOvernightOptions(getFirestore().collection('trips').doc(tripId))

    expect((await committedNights(tripId)).map((night) => night.type)).toEqual([
      'campsite',
      'campsite',
    ])
  })

  // Setting the slider to zero is how someone who wants facilities every
  // night says so, and it has to restore exactly the pre-2026-08-13 behaviour.
  it('never goes off grid at all with a tolerance of zero', async () => {
    await seedFreeCampingRules('NO', [ALLEMANNSRETTEN])
    const tripId = await seedTrip('uidOffGridZero', {
      country: 'NO',
      offGridTolerance: 0,
      types: ['drive', 'drive'],
    })

    const { applyOvernightOptions } = await import('./overnightOptions.js')
    await applyOvernightOptions(getFirestore().collection('trips').doc(tripId))

    expect((await committedNights(tripId)).map((night) => night.type)).toEqual([
      'campsite',
      'campsite',
    ])
  })

  // A rest day is a whole day parked in one place, so it gets facilities
  // mid-run or not — and servicing the RV restarts the budget, so the free
  // nights resume after it rather than being cut short by it.
  it('gives a rest day facilities and restarts the budget after it', async () => {
    await seedFreeCampingRules('NO', [ALLEMANNSRETTEN])
    const tripId = await seedTrip('uidOffGridRestDay', {
      country: 'NO',
      offGridTolerance: 2,
      types: ['drive', 'rest', 'drive', 'drive'],
    })

    const { applyOvernightOptions } = await import('./overnightOptions.js')
    await applyOvernightOptions(getFirestore().collection('trips').doc(tripId))

    expect((await committedNights(tripId)).map((night) => night.type)).toEqual([
      'wild',
      'campsite',
      'wild',
      'wild',
    ])
  })

  // Servicing is due and this stretch of road has nowhere to do it. The night
  // still gets a real place rather than a town-centre intersection, and the
  // tanks stay due — so the very next day, where a campsite does exist, takes
  // it instead of starting a fresh run of free nights.
  it('carries an unmet servicing requirement into the next day', async () => {
    await seedFreeCampingRules('NO', [ALLEMANNSRETTEN])
    const tripId = await seedTrip('uidOffGridNoService', {
      country: 'NO',
      offGridTolerance: 1,
      types: ['drive', 'drive', 'drive'],
    })

    findNearbyCampsitesMock.mockReset()
    // Day 2 is the one with nothing serviced anywhere near it.
    findNearbyCampsitesMock
      .mockResolvedValueOnce([CAMPSITE])
      .mockResolvedValueOnce([])
      .mockResolvedValue([CAMPSITE])

    const { applyOvernightOptions } = await import('./overnightOptions.js')
    await applyOvernightOptions(getFirestore().collection('trips').doc(tripId))
    findNearbyCampsitesMock.mockReset().mockResolvedValue([CAMPSITE])

    expect((await committedNights(tripId)).map((night) => night.type)).toEqual([
      'wild',
      'wild',
      'campsite',
    ])
  })
})
