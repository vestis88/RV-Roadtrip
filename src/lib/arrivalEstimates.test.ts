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

  /**
   * Reported 2026-08-31 with a screenshot: a stop on the route AHEAD, not
   * marked done, showing 2026-08-20 — eleven days in the past — directly
   * under a banner reading "These days are from an earlier plan". Both
   * sentences came from this file: the committed date won outright, and the
   * day it won with belonged to a plan the traveler had already driven past.
   *
   * A past day on a stop nobody marked done is not a commitment; it is
   * residue. The packing counts forward from today and is strictly better
   * informed about a stop still ahead.
   */
  it('ignores a committed day that has already been and gone', () => {
    const estimates = arrivalEstimates({
      ...BASE,
      today: '2026-08-31',
      routeStops: [stop('a', { linkedDayIds: ['old'] })],
      days: [
        { id: 'old', index: 0, date: '2026-08-20' } as unknown as TripDayWithId,
      ],
    })
    // Today, from the packing — not the 20th, and never a date behind the
    // traveler.
    expect(estimates.get('a')).toEqual({ date: '2026-08-31', committed: false })
  })

  // The boundary, stated so "still ahead" cannot quietly become "strictly
  // ahead": a day happening today is the day you are living, not residue.
  it('still honours a committed day that is today', () => {
    const estimates = arrivalEstimates({
      ...BASE,
      today: '2026-08-31',
      routeStops: [stop('a', { linkedDayIds: ['now'] })],
      days: [
        { id: 'now', index: 0, date: '2026-08-31' } as unknown as TripDayWithId,
      ],
    })
    expect(estimates.get('a')?.committed).toBe(true)
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
