import { getFirestore } from 'firebase-admin/firestore'
import { initializeApp } from 'firebase-admin/app'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTripForUser } from './trips.js'
import type { TripDay } from '@rv/shared'

const PROJECT_ID = 'demo-rv-trip-planner'

beforeAll(() => {
  initializeApp({ projectId: PROJECT_ID })
  getFirestore().settings({ ignoreUndefinedProperties: true })
})

// Claude and the Places enrichment are mocked; what these test is the
// orchestration — what gets written, what gets left alone, and what the day
// document ends up saying — against the real emulator.
const generateDaySectionMock = vi.fn()
vi.mock('./prompts/planTrip.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./prompts/planTrip.js')>()
  return {
    ...actual,
    generateDaySection: (...args: unknown[]) => generateDaySectionMock(...args),
  }
})

const enrichDayDetailMock = vi.fn()
vi.mock('./dayDetail.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./dayDetail.js')>()
  return {
    ...actual,
    enrichDayDetail: (...args: unknown[]) => enrichDayDetailMock(...args),
  }
})

// Shaped as `enrichDayDetail` returns them, not as Claude proposes them:
// the coordinates are what verification through Places adds, and the
// schemas the callable parses against require them.
function restaurant(name: string, meal: string) {
  return {
    name,
    town: 'Town 0',
    meal,
    blurb: `Two real sentences about ${name}.`,
    status: 'suggested',
    lat: 59,
    lng: 10,
  }
}

function activity(name: string) {
  return {
    name,
    town: 'Town 0',
    category: 'sight',
    kidFriendly: true,
    blurb: `Two real sentences about ${name}.`,
    status: 'suggested',
    lat: 59,
    lng: 10,
  }
}

async function tripWithADay(uid: string) {
  const { tripId } = await createTripForUser(uid)
  const tripRef = getFirestore().collection('trips').doc(tripId)
  await tripRef.update({ 'planMeta.status': 'ready' })
  const ref = tripRef.collection('days').doc()
  const day: TripDay = {
    index: 0,
    date: '2026-07-10',
    type: 'drive',
    overnight: { name: 'Town 0', lat: 59, lng: 10, country: 'NO' },
    townAnchor: { lat: 59, lng: 10 },
    summary: 'Outline sentence',
    detailStatus: 'pending',
  }
  await ref.set(day)
  return { tripId, dayId: ref.id, dayRef: ref }
}

beforeEach(() => {
  enrichDayDetailMock.mockReset()
  generateDaySectionMock.mockReset()
})

/**
 * Requested 2026-08-25: "the content could be generated for it with a click
 * on that empty header (lunch) for instance."
 */
describe('runDetailDaySection', () => {
  it('writes only the meal that was asked for', async () => {
    const { tripId, dayId, dayRef } = await tripWithADay('uidSectionA')
    generateDaySectionMock.mockResolvedValue({
      restaurants: [restaurant('Osteria', 'lunch')],
    })
    enrichDayDetailMock.mockResolvedValue({
      activities: [],
      restaurants: [restaurant('Osteria', 'lunch')],
    })

    const { runDetailDaySection } = await import(
      './detailDaySectionCallable.js'
    )
    const result = await runDetailDaySection(tripId, dayId, 'restaurant', 'lunch')

    expect(result).toMatchObject({ section: 'lunch', written: 1 })
    const written = await dayRef.collection('restaurants').get()
    expect(written.docs.map((d) => d.data().name)).toEqual(['Osteria'])
  })

  /**
   * The difference from `detailDays` that matters most. That one clears a
   * day's activities AND restaurants before writing, which is right for a
   * whole-day pass and would destroy the other three sections here.
   */
  it('leaves the other sections of the day alone', async () => {
    const { tripId, dayId, dayRef } = await tripWithADay('uidSectionB')
    await dayRef.collection('restaurants').doc('dinner-0').set(restaurant('Trattoria', 'dinner'))
    await dayRef.collection('activities').doc('activity-0').set(activity('A gorge walk'))

    generateDaySectionMock.mockResolvedValue({
      restaurants: [restaurant('Bakery', 'breakfast')],
    })
    enrichDayDetailMock.mockResolvedValue({
      activities: [],
      restaurants: [restaurant('Bakery', 'breakfast')],
    })

    const { runDetailDaySection } = await import(
      './detailDaySectionCallable.js'
    )
    await runDetailDaySection(tripId, dayId, 'restaurant', 'breakfast')

    const restaurants = await dayRef.collection('restaurants').get()
    expect(restaurants.docs.map((d) => d.data().name).sort()).toEqual([
      'Bakery',
      'Trattoria',
    ])
    const activities = await dayRef.collection('activities').get()
    expect(activities.docs.map((d) => d.data().name)).toEqual(['A gorge walk'])
  })

  /**
   * The whole reason this exists. `detailStatus: 'ready'` is what
   * planSkeleton refuses to rebuild over, so setting it here would freeze
   * the day list the moment one meal was filled — which is the opposite of
   * what was asked for.
   */
  it('records the section without marking the whole day ready', async () => {
    const { tripId, dayId, dayRef } = await tripWithADay('uidSectionC')
    generateDaySectionMock.mockResolvedValue({ activities: [activity('A gorge walk')] })
    enrichDayDetailMock.mockResolvedValue({
      activities: [activity('A gorge walk')],
      restaurants: [],
    })

    const { runDetailDaySection } = await import(
      './detailDaySectionCallable.js'
    )
    await runDetailDaySection(tripId, dayId, 'activity')

    const day = (await dayRef.get()).data() as TripDay
    expect(day.detailStatus).toBe('pending')
    expect(day.filledSections).toEqual(['activity'])
  })

  it('accumulates the sections that have been asked for', async () => {
    const { tripId, dayId, dayRef } = await tripWithADay('uidSectionD')
    generateDaySectionMock.mockResolvedValue({ restaurants: [] })
    enrichDayDetailMock.mockResolvedValue({ activities: [], restaurants: [] })

    const { runDetailDaySection } = await import(
      './detailDaySectionCallable.js'
    )
    await runDetailDaySection(tripId, dayId, 'restaurant', 'lunch')
    await runDetailDaySection(tripId, dayId, 'restaurant', 'dinner')

    const day = (await dayRef.get()).data() as TripDay
    expect([...(day.filledSections ?? [])].sort()).toEqual(['dinner', 'lunch'])
  })

  /**
   * Deterministic document ids, so two taps that race cannot each delete the
   * old scope and then add their own three, leaving six.
   */
  it('replaces its own scope rather than adding to it', async () => {
    const { tripId, dayId, dayRef } = await tripWithADay('uidSectionE')
    generateDaySectionMock.mockResolvedValue({ restaurants: [] })
    enrichDayDetailMock.mockResolvedValue({
      activities: [],
      restaurants: [restaurant('Osteria', 'lunch'), restaurant('Pizzeria', 'lunch')],
    })

    const { runDetailDaySection } = await import(
      './detailDaySectionCallable.js'
    )
    await runDetailDaySection(tripId, dayId, 'restaurant', 'lunch')
    await runDetailDaySection(tripId, dayId, 'restaurant', 'lunch')

    const written = await dayRef.collection('restaurants').get()
    expect(written.size).toBe(2)
  })

  // A whole-day run owns the day while it is generating and would clear
  // whatever this wrote on its way past.
  it('refuses while a whole-day run holds the day', async () => {
    const { tripId, dayId, dayRef } = await tripWithADay('uidSectionF')
    await dayRef.update({ detailStatus: 'generating' })

    const { runDetailDaySection } = await import(
      './detailDaySectionCallable.js'
    )
    await expect(
      runDetailDaySection(tripId, dayId, 'restaurant', 'lunch'),
    ).rejects.toThrow(/already being filled in/)
  })
})
