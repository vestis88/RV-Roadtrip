import { describe, expect, it } from 'vitest'
import { arrivalEstimates } from './arrivalEstimates'
import type { CorridorStopWithId } from '../hooks/useCorridorStops'
import type { TripDayWithId } from '../hooks/useTripDays'

function stop(
  id: string,
  over: Partial<CorridorStopWithId> = {},
): CorridorStopWithId {
  return {
    id,
    name: id,
    lat: 47,
    lng: 11,
    country: 'DE',
    status: 'locked',
    linkedDayIds: [],
    timeNeeded: 'half-day',
    ...over,
  } as CorridorStopWithId
}

const BASE = {
  days: [] as TripDayWithId[],
  startDate: '2026-08-20',
  maxDriveHoursPerDay: 5,
  today: '2026-08-01',
}

/** Requested 2026-08-24: "Locked in activities should get an estimated date." */
describe('estimated arrival dates', () => {
  it('dates each stop from the packing, in route order', () => {
    const estimates = arrivalEstimates({
      ...BASE,
      routeStops: [stop('a'), stop('b')],
      legs: [{ durationMin: 60 }, { durationMin: 300 }],
    })
    expect(estimates.get('a')?.date).toBe('2026-08-20')
    // A five-hour drive plus a half-day sight cannot share the first day.
    expect(estimates.get('b')?.date).toBe('2026-08-21')
  })

  /**
   * Counting from startDate once the trip is under way would say a stop
   * lands on a date already past. An estimate confidently behind the
   * traveler is worse than none.
   */
  it('counts from today once the trip is running', () => {
    const estimates = arrivalEstimates({
      ...BASE,
      today: '2026-08-24',
      routeStops: [stop('a')],
    })
    expect(estimates.get('a')?.date).toBe('2026-08-24')
  })

  it('counts from the start date while the trip is still ahead', () => {
    const estimates = arrivalEstimates({
      ...BASE,
      today: '2026-08-01',
      routeStops: [stop('a')],
    })
    expect(estimates.get('a')?.date).toBe('2026-08-20')
  })

  /**
   * The packing is a fast greedy estimate; the day plan is the committed
   * answer. Two things claiming to say "when" is how the header and the
   * itinerary came to disagree before.
   */
  it('lets a real day override the estimate', () => {
    const estimates = arrivalEstimates({
      ...BASE,
      routeStops: [stop('a', { linkedDayIds: ['d9'] })],
      days: [
        { id: 'd9', index: 4, date: '2026-08-28' } as unknown as TripDayWithId,
      ],
    })
    expect(estimates.get('a')).toEqual({ date: '2026-08-28', committed: true })
  })

  // Done stops are already out of packStopsIntoDays, so what is left pulls
  // forward as things are ticked off — the behaviour that makes this useful.
  it('pulls the remaining stops forward as earlier ones are done', () => {
    const withAllAhead = arrivalEstimates({
      ...BASE,
      routeStops: [stop('a', { stayDuration: { kind: 'nights', nights: 3 } }), stop('b')],
    })
    const afterFirstDone = arrivalEstimates({
      ...BASE,
      routeStops: [
        stop('a', {
          stayDuration: { kind: 'nights', nights: 3 },
          doneAt: '2026-08-20T10:00:00.000Z',
        }),
        stop('b'),
      ],
    })
    expect(withAllAhead.get('b')?.date).toBe('2026-08-23')
    expect(afterFirstDone.get('b')?.date).toBe('2026-08-20')
  })

  it('produces nothing without a start date', () => {
    expect(
      arrivalEstimates({ ...BASE, startDate: '', routeStops: [stop('a')] }).size,
    ).toBe(0)
  })
})
