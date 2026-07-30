import { getFirestore } from 'firebase-admin/firestore'
import { initializeApp } from 'firebase-admin/app'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTripForUser } from './trips.js'
import type { Activity, Restaurant, TripDay } from '@rv/shared'

const PROJECT_ID = 'demo-rv-trip-planner'

beforeAll(() => {
  initializeApp({ projectId: PROJECT_ID })
  getFirestore().settings({ ignoreUndefinedProperties: true })
})

// runResearchMoreAlternatives checks googlePlacesApiKey.value() itself
// (fails fast with a clear error before ever calling the — here mocked —
// backfill helpers), so every test needs it stubbed even though the
// backfill functions themselves are mocked.
beforeEach(() => {
  vi.stubEnv('GOOGLE_PLACES_API_KEY', 'test-key')
})
afterEach(() => {
  vi.unstubAllEnvs()
})

// Only the Places-touching backfill helpers are mocked (no real credentials
// here, same as every other Places-touching test in this codebase) — the
// orchestration itself (near/excludeIds derivation, meal scoping, writing
// results) runs for real against the Firestore emulator.
const backfillActivitiesMock = vi.fn()
const backfillRestaurantsForMealMock = vi.fn()
vi.mock('./placesApi.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./placesApi.js')>()
  return {
    ...actual,
    backfillActivities: (...args: unknown[]) => backfillActivitiesMock(...args),
    backfillRestaurantsForMeal: (...args: unknown[]) =>
      backfillRestaurantsForMealMock(...args),
  }
})

function activity(overrides: Partial<Activity> = {}): Activity {
  return {
    name: 'Existing activity',
    category: 'sight',
    lat: 61.2,
    lng: 10.6,
    blurb: 'x',
    kidFriendly: true,
    status: 'suggested',
    ...overrides,
  }
}

function restaurant(overrides: Partial<Restaurant> = {}): Restaurant {
  return {
    name: 'Existing restaurant',
    meal: 'breakfast',
    lat: 61.2,
    lng: 10.6,
    blurb: 'x',
    status: 'suggested',
    ...overrides,
  }
}

async function seedDay(tripId: string, dayId: string): Promise<void> {
  const day: TripDay = {
    index: 0,
    date: '2026-08-01',
    type: 'drive',
    overnight: { name: 'Lillehammer', lat: 61.1, lng: 10.5, country: 'NO' },
    summary: 'A day',
  }
  await getFirestore()
    .collection('trips')
    .doc(tripId)
    .collection('days')
    .doc(dayId)
    .set(day)
}

describe('runResearchMoreAlternatives — activities', () => {
  it("excludes every existing activity's placeId and anchors near an existing one's coordinates", async () => {
    const { tripId } = await createTripForUser('uidResearchA')
    const dayRef = getFirestore()
      .collection('trips')
      .doc(tripId)
      .collection('days')
      .doc('day1')
    await seedDay(tripId, 'day1')
    await Promise.all([
      dayRef.collection('activities').add(
        activity({ placeId: 'p1', lat: 61.3, lng: 10.7 }),
      ),
      dayRef
        .collection('activities')
        .add(activity({ placeId: 'p2', status: 'skipped' })),
      dayRef
        .collection('activities')
        .add(activity({ placeId: 'p3', reserve: true })),
      // No placeId — older data, simply can't be excluded by ID.
      dayRef.collection('activities').add(activity({ name: 'No placeId' })),
    ])

    backfillActivitiesMock
      .mockReset()
      .mockResolvedValue([activity({ name: 'Fresh find', placeId: 'p4' })])

    const { runResearchMoreAlternatives } = await import(
      './researchMoreAlternativesCallable.js'
    )
    const added = await runResearchMoreAlternatives(tripId, 'day1', 'activity')

    expect(added).toBe(1)
    expect(backfillActivitiesMock).toHaveBeenCalledTimes(1)
    const [near, excludeIds] = backfillActivitiesMock.mock.calls[0]
    expect(excludeIds).toEqual(new Set(['p1', 'p2', 'p3']))
    // Anchored at one of the existing docs' own coordinates, not the day's
    // overnight point.
    expect([61.2, 61.3]).toContain(near.lat)

    const activitiesSnap = await dayRef.collection('activities').get()
    expect(activitiesSnap.docs.some((d) => d.data().name === 'Fresh find')).toBe(
      true,
    )
  })

  it("falls back to the day's own overnight point when the scope has no existing activities", async () => {
    const { tripId } = await createTripForUser('uidResearchB')
    await seedDay(tripId, 'day1')

    backfillActivitiesMock.mockReset().mockResolvedValue([])

    const { runResearchMoreAlternatives } = await import(
      './researchMoreAlternativesCallable.js'
    )
    const added = await runResearchMoreAlternatives(tripId, 'day1', 'activity')

    expect(added).toBe(0)
    const [near, excludeIds] = backfillActivitiesMock.mock.calls[0]
    expect(near).toEqual({ lat: 61.1, lng: 10.5 })
    expect(excludeIds.size).toBe(0)
  })

  it('throws not-found for a day that does not exist', async () => {
    const { tripId } = await createTripForUser('uidResearchC')
    const { runResearchMoreAlternatives } = await import(
      './researchMoreAlternativesCallable.js'
    )
    await expect(
      runResearchMoreAlternatives(tripId, 'nonexistent-day', 'activity'),
    ).rejects.toThrow()
  })

  it('defaults to making every found item immediately visible', async () => {
    const { tripId } = await createTripForUser('uidResearchVisDefault')
    const dayRef = getFirestore()
      .collection('trips')
      .doc(tripId)
      .collection('days')
      .doc('day1')
    await seedDay(tripId, 'day1')

    backfillActivitiesMock
      .mockReset()
      .mockResolvedValue([
        activity({ name: 'One', placeId: 'v1' }),
        activity({ name: 'Two', placeId: 'v2' }),
        activity({ name: 'Three', placeId: 'v3' }),
      ])

    const { runResearchMoreAlternatives } = await import(
      './researchMoreAlternativesCallable.js'
    )
    const added = await runResearchMoreAlternatives(tripId, 'day1', 'activity')

    expect(added).toBe(3)
    const activitiesSnap = await dayRef.collection('activities').get()
    expect(activitiesSnap.docs.every((d) => !(d.data() as Activity).reserve)).toBe(
      true,
    )
  })

  it('holds back everything past visibleCount as reserve rather than making it all visible', async () => {
    const { tripId } = await createTripForUser('uidResearchVisCapped')
    const dayRef = getFirestore()
      .collection('trips')
      .doc(tripId)
      .collection('days')
      .doc('day1')
    await seedDay(tripId, 'day1')

    backfillActivitiesMock
      .mockReset()
      .mockResolvedValue([
        activity({ name: 'One', placeId: 'v1' }),
        activity({ name: 'Two', placeId: 'v2' }),
        activity({ name: 'Three', placeId: 'v3' }),
      ])

    const { runResearchMoreAlternatives } = await import(
      './researchMoreAlternativesCallable.js'
    )
    const added = await runResearchMoreAlternatives(
      tripId,
      'day1',
      'activity',
      undefined,
      1,
    )

    expect(added).toBe(3)
    const activitiesSnap = await dayRef.collection('activities').get()
    const byName = new Map(
      activitiesSnap.docs.map((d) => [
        (d.data() as Activity).name,
        (d.data() as Activity).reserve ?? false,
      ]),
    )
    expect(byName.get('One')).toBe(false)
    expect(byName.get('Two')).toBe(true)
    expect(byName.get('Three')).toBe(true)
  })
})

describe('runResearchMoreAlternatives — restaurants', () => {
  it('scopes existing-item exclusion and the near anchor to the requested meal only', async () => {
    const { tripId } = await createTripForUser('uidResearchD')
    const dayRef = getFirestore()
      .collection('trips')
      .doc(tripId)
      .collection('days')
      .doc('day1')
    await seedDay(tripId, 'day1')
    await Promise.all([
      dayRef.collection('restaurants').add(
        restaurant({ meal: 'breakfast', placeId: 'b1', lat: 61.4, lng: 10.8 }),
      ),
      dayRef
        .collection('restaurants')
        .add(restaurant({ meal: 'dinner', placeId: 'd1' })),
    ])

    backfillRestaurantsForMealMock
      .mockReset()
      .mockResolvedValue([
        restaurant({ meal: 'breakfast', name: 'Fresh cafe', placeId: 'b2' }),
      ])

    const { runResearchMoreAlternatives } = await import(
      './researchMoreAlternativesCallable.js'
    )
    const added = await runResearchMoreAlternatives(
      tripId,
      'day1',
      'restaurant',
      'breakfast',
    )

    expect(added).toBe(1)
    const [meal, near, excludeIds] = backfillRestaurantsForMealMock.mock.calls[0]
    expect(meal).toBe('breakfast')
    expect(near).toEqual({ lat: 61.4, lng: 10.8 })
    // Only the breakfast placeId is excluded — dinner's is a different meal.
    expect(excludeIds).toEqual(new Set(['b1']))

    const restaurantsSnap = await dayRef.collection('restaurants').get()
    expect(
      restaurantsSnap.docs.some((d) => d.data().name === 'Fresh cafe'),
    ).toBe(true)
  })
})
