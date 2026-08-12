import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlanTripSkeletonDay } from './prompts/planTripSchema.js'

// resolveSkeletonDay's own geocoding/enrichment calls are mocked here (same
// module-level vi.mock approach overnightCandidatesCallable.test.ts uses) so
// only the anchor-selection logic under test — which point activities and
// restaurants get searched near — is exercised, not real Places/Routes
// access.
const geocodeQueryMock = vi.fn()
const enrichActivitiesMock = vi.fn()
const enrichRestaurantsForMealMock = vi.fn()
vi.mock('./placesApi.js', () => ({
  geocodeQuery: (...args: unknown[]) => geocodeQueryMock(...args),
  enrichActivities: (...args: unknown[]) => enrichActivitiesMock(...args),
  enrichRestaurantsForMeal: (...args: unknown[]) =>
    enrichRestaurantsForMealMock(...args),
}))

const computeRouteLegMock = vi.fn()
vi.mock('./routesApi.js', () => ({
  computeRouteLeg: (...args: unknown[]) => computeRouteLegMock(...args),
}))

const CURRENT_LOCATION = { name: 'Yesterday town', lat: 50, lng: 10 }
const NEW_OVERNIGHT_POINT = { lat: 55, lng: 15 }

const ONE_OF_EACH_MEAL = [
  { name: 'Breakfast spot', town: 'Somewhere', meal: 'breakfast' as const, blurb: 'x' },
  { name: 'Lunch spot', town: 'Somewhere', meal: 'lunch' as const, blurb: 'x' },
  { name: 'Dinner spot', town: 'Somewhere', meal: 'dinner' as const, blurb: 'x' },
]

function driveDay(slot?: 'morning' | 'midday' | 'evening'): PlanTripSkeletonDay {
  return {
    index: 0,
    date: '2026-08-01',
    type: 'drive',
    overnight: { name: 'New town', town: 'New town', country: 'NO' },
    // `drive` (and, within it, `slot`) is only present when the caller asked
    // for one — matching PlanTripSkeletonDay's real shape, where `drive` is
    // optional but `slot` is required once `drive` exists. Omitting it
    // entirely is how "unspecified" is represented, exercising resolveSkeletonDay's
    // own `skDay.drive?.slot ?? 'evening'` default.
    ...(slot
      ? { drive: { fromTown: CURRENT_LOCATION.name, toTown: 'New town', slot } }
      : {}),
    summary: 'A day',
    activities: [
      { name: 'Hike', town: 'Somewhere', category: 'hike', kidFriendly: true, blurb: 'x' },
    ],
    restaurants: ONE_OF_EACH_MEAL,
  }
}

function restDay(): PlanTripSkeletonDay {
  return {
    index: 0,
    date: '2026-08-01',
    type: 'rest',
    overnight: { name: '', town: '', country: 'NO' },
    summary: 'A rest day',
    activities: [
      { name: 'Museum', town: 'Somewhere', category: 'museum', kidFriendly: true, blurb: 'x' },
    ],
    restaurants: ONE_OF_EACH_MEAL,
  }
}

describe('resolveSkeletonDay — activity/restaurant geocoding anchor', () => {
  beforeEach(() => {
    geocodeQueryMock.mockReset().mockResolvedValue(NEW_OVERNIGHT_POINT)
    computeRouteLegMock
      .mockReset()
      .mockResolvedValue({ distanceKm: 100, durationMin: 90 })
    enrichActivitiesMock.mockReset().mockResolvedValue([])
    enrichRestaurantsForMealMock.mockReset().mockResolvedValue([])
  })

  it('anchors near currentLocation for a drive day defaulting to the evening slot — the day is spent where it started, arriving at the new overnight only after dinner', async () => {
    const { resolveSkeletonDay } = await import('./planPipeline.js')
    await resolveSkeletonDay(driveDay(), CURRENT_LOCATION)

    const expectedNear = { lat: CURRENT_LOCATION.lat, lng: CURRENT_LOCATION.lng }
    expect(enrichActivitiesMock).toHaveBeenCalledWith(expect.anything(), expectedNear)
    expect(enrichRestaurantsForMealMock).toHaveBeenCalledWith(
      expect.anything(),
      'breakfast',
      expectedNear,
      expect.anything(),
    )
    expect(enrichRestaurantsForMealMock).toHaveBeenCalledWith(
      expect.anything(),
      'dinner',
      expectedNear,
      expect.anything(),
    )
  })

  it('anchors near currentLocation for a drive day with an explicit evening slot too', async () => {
    const { resolveSkeletonDay } = await import('./planPipeline.js')
    await resolveSkeletonDay(driveDay('evening'), CURRENT_LOCATION)

    expect(enrichActivitiesMock).toHaveBeenCalledWith(expect.anything(), {
      lat: CURRENT_LOCATION.lat,
      lng: CURRENT_LOCATION.lng,
    })
  })

  it('anchors near the new overnight for a morning-slot drive day — arrival happens before that day\'s activities', async () => {
    const { resolveSkeletonDay } = await import('./planPipeline.js')
    await resolveSkeletonDay(driveDay('morning'), CURRENT_LOCATION)

    expect(enrichActivitiesMock).toHaveBeenCalledWith(
      expect.anything(),
      NEW_OVERNIGHT_POINT,
    )
  })

  it('anchors near the new overnight for a midday-slot drive day', async () => {
    const { resolveSkeletonDay } = await import('./planPipeline.js')
    await resolveSkeletonDay(driveDay('midday'), CURRENT_LOCATION)

    expect(enrichActivitiesMock).toHaveBeenCalledWith(
      expect.anything(),
      NEW_OVERNIGHT_POINT,
    )
  })

  it('anchors near overnight (== currentLocation) for a rest day', async () => {
    const { resolveSkeletonDay } = await import('./planPipeline.js')
    await resolveSkeletonDay(restDay(), CURRENT_LOCATION)

    // Rest days never geocode — overnight is set to currentLocation directly.
    expect(geocodeQueryMock).not.toHaveBeenCalled()
    expect(enrichActivitiesMock).toHaveBeenCalledWith(expect.anything(), {
      lat: CURRENT_LOCATION.lat,
      lng: CURRENT_LOCATION.lng,
    })
  })
})

// Where the day sleeps is resolved later, in one pass over the whole trip
// (applyOvernightOptions) — the corridor-wide OSM query it needs wants every
// day's location at once, and this resolver only ever sees one day. What this
// stage owes that pass is the town, recorded so re-running it searches around
// the town again instead of around the last site it picked.
describe('resolveSkeletonDay — records the town for the overnight pass', () => {
  beforeEach(() => {
    geocodeQueryMock.mockReset().mockResolvedValue(NEW_OVERNIGHT_POINT)
    computeRouteLegMock
      .mockReset()
      .mockResolvedValue({ distanceKm: 100, durationMin: 90 })
    enrichActivitiesMock.mockReset().mockResolvedValue([])
    enrichRestaurantsForMealMock.mockReset().mockResolvedValue([])
  })

  it('leaves the overnight on the town until the overnight pass runs', async () => {
    const { resolveSkeletonDay } = await import('./planPipeline.js')
    const { generated } = await resolveSkeletonDay(driveDay(), CURRENT_LOCATION)

    expect(generated.day.overnight).toMatchObject(NEW_OVERNIGHT_POINT)
    expect(generated.day.townAnchor).toEqual(NEW_OVERNIGHT_POINT)
  })

  it('records the previous stop as the town for a rest day', async () => {
    const { resolveSkeletonDay } = await import('./planPipeline.js')
    const { generated } = await resolveSkeletonDay(restDay(), CURRENT_LOCATION)

    expect(generated.day.townAnchor).toEqual({
      lat: CURRENT_LOCATION.lat,
      lng: CURRENT_LOCATION.lng,
    })
  })

  it('hands the next day the town', async () => {
    const { resolveSkeletonDay } = await import('./planPipeline.js')
    const { nextLocation } = await resolveSkeletonDay(driveDay(), CURRENT_LOCATION)

    expect(nextLocation).toEqual({ name: 'New town', ...NEW_OVERNIGHT_POINT })
  })
})

// Segmented generation (2026-07-31): resolveSkeletonDays' own deadline
// support — the piece generateRealPlan/generatePlan.ts build the
// chain-a-continuation-request behavior on top of. Kept as a focused unit
// test here rather than only exercised indirectly through generatePlan.ts's
// mocked-resolveSkeletonDays tests, since this is the actual code that
// decides where the cutoff falls.
describe('resolveSkeletonDays — deadline', () => {
  beforeEach(() => {
    geocodeQueryMock.mockReset().mockResolvedValue(NEW_OVERNIGHT_POINT)
    computeRouteLegMock
      .mockReset()
      .mockResolvedValue({ distanceKm: 100, durationMin: 90 })
    enrichActivitiesMock.mockReset().mockResolvedValue([])
    enrichRestaurantsForMealMock.mockReset().mockResolvedValue([])
  })

  it('resolves nothing and touches no Places/Routes call when the deadline has already passed', async () => {
    const { resolveSkeletonDays } = await import('./planPipeline.js')
    const days = [driveDay('morning'), driveDay('morning'), driveDay('morning')]

    const resolved = await resolveSkeletonDays(
      days,
      CURRENT_LOCATION,
      undefined,
      undefined,
      Date.now() - 1,
    )

    expect(resolved).toHaveLength(0)
    expect(geocodeQueryMock).not.toHaveBeenCalled()
  })

  it('resolves every day when the deadline is comfortably in the future', async () => {
    const { resolveSkeletonDays } = await import('./planPipeline.js')
    const days = [driveDay('morning'), driveDay('morning')]

    const resolved = await resolveSkeletonDays(
      days,
      CURRENT_LOCATION,
      undefined,
      undefined,
      Date.now() + 60_000,
    )

    expect(resolved).toHaveLength(2)
  })

  it('stops partway through once a slow day pushes past the deadline, keeping everything resolved before that', async () => {
    let calls = 0
    computeRouteLegMock.mockImplementation(async () => {
      calls++
      if (calls === 1) {
        // Simulate the first day's own resolution taking long enough to
        // blow past the deadline before the second day is even considered
        // — the check has to happen before starting *each* day, not just
        // once at the top of the loop.
        await new Promise((resolve) => setTimeout(resolve, 80))
      }
      return { distanceKm: 100, durationMin: 90 }
    })
    const deadline = Date.now() + 50
    const days = [driveDay('morning'), driveDay('morning'), driveDay('morning')]

    const { resolveSkeletonDays } = await import('./planPipeline.js')
    const resolved = await resolveSkeletonDays(
      days,
      CURRENT_LOCATION,
      undefined,
      undefined,
      deadline,
    )

    expect(resolved.length).toBeGreaterThanOrEqual(1)
    expect(resolved.length).toBeLessThan(3)
  })

  it('never checks the deadline when none is supplied — every existing caller (replanTrip.ts) is unaffected', async () => {
    const { resolveSkeletonDays } = await import('./planPipeline.js')
    const days = [driveDay('morning'), driveDay('morning')]

    const resolved = await resolveSkeletonDays(days, CURRENT_LOCATION)

    expect(resolved).toHaveLength(2)
  })
})
