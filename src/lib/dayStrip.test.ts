import { describe, expect, it } from 'vitest'
import { dayStrip } from './dayStrip'
import type { TripDayWithId } from '../hooks/useTripDays'

function day(index: number, date: string): TripDayWithId {
  return {
    id: `d${index}`,
    index,
    date,
    type: 'drive',
    overnight: { name: `Town ${index}`, lat: 47, lng: 11, country: 'DE' },
    summary: '',
  } as unknown as TripDayWithId
}

const DAYS = [
  day(0, '2026-08-20'),
  day(1, '2026-08-21'),
  day(2, '2026-08-22'),
  day(3, '2026-08-23'),
]

/**
 * Reported 2026-08-25: "The days on top are still som old irrelevant stuff.
 * I want info about today, tomorrow and so on."
 */
describe('the day strip', () => {
  it('starts at today once the trip is under way', () => {
    const { upcoming } = dayStrip(DAYS, '2026-08-22')
    expect(upcoming.map((chip) => chip.day.id)).toEqual(['d2', 'd3'])
  })

  it('names the two days anyone actually acts on', () => {
    const { upcoming } = dayStrip(DAYS, '2026-08-21')
    expect(upcoming.map((chip) => chip.label)).toEqual([
      'Today',
      'Tomorrow',
      '23 Aug',
    ])
  })

  // Hidden, not deleted: "where did we sleep on Tuesday" is a real question.
  it('keeps the days behind you reachable', () => {
    const { past } = dayStrip(DAYS, '2026-08-22')
    expect(past.map((chip) => chip.day.id)).toEqual(['d0', 'd1'])
  })

  /**
   * Before the trip there is no "today" inside it, so nothing should be
   * relabelled — the strip is a plan, not a countdown.
   */
  it('numbers the days while the trip is still ahead', () => {
    const { upcoming, past } = dayStrip(DAYS, '2026-08-01')
    expect(upcoming.map((chip) => chip.label)).toEqual([
      'Day 1',
      'Day 2',
      'Day 3',
      'Day 4',
    ])
    expect(past).toEqual([])
  })

  /**
   * A finished trip has no "today" in it either, and calling its last day
   * "Today" would be a lie — so it falls back the same way.
   */
  it('numbers the days again once the trip is over', () => {
    const { upcoming, past } = dayStrip(DAYS, '2026-09-15')
    expect(upcoming.map((chip) => chip.label)).toEqual([
      'Day 1',
      'Day 2',
      'Day 3',
      'Day 4',
    ])
    expect(past).toEqual([])
  })

  it('survives a trip with no days at all', () => {
    expect(dayStrip([], '2026-08-22')).toEqual({ upcoming: [], past: [] })
  })

  // The strip is ordered by the plan, not by whatever order the snapshot
  // happened to arrive in.
  it('reads in plan order regardless of input order', () => {
    const { upcoming } = dayStrip([DAYS[3], DAYS[2]], '2026-08-22')
    expect(upcoming.map((chip) => chip.day.id)).toEqual(['d2', 'd3'])
  })
})
