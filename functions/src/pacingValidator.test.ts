import { describe, expect, it } from 'vitest'
import type { TripDay } from '@rv/shared'
import { pacingWarnings, validatePacing } from './pacingValidator.js'

function day(overrides: Partial<TripDay> & { index: number }): TripDay {
  return {
    date: `2026-07-${String(10 + overrides.index).padStart(2, '0')}`,
    type: 'drive',
    overnight: { name: `Stop ${overrides.index}`, lat: 0, lng: 0, country: 'NO' },
    summary: '',
    ...overrides,
  }
}

describe('validatePacing', () => {
  it('passes a well-paced plan with a rest day that stays in place', () => {
    const days: TripDay[] = [
      day({
        index: 0,
        overnight: { name: 'Lillehammer', lat: 0, lng: 0, country: 'NO' },
        drive: {
          fromName: 'Oslo',
          toName: 'Lillehammer',
          distanceKm: 180,
          durationMin: 150,
          slot: 'morning',
        },
      }),
      day({
        index: 1,
        type: 'rest',
        overnight: { name: 'Lillehammer', lat: 0, lng: 0, country: 'NO' },
      }),
      day({
        index: 2,
        overnight: { name: 'Otta', lat: 0, lng: 0, country: 'NO' },
        drive: {
          fromName: 'Lillehammer',
          toName: 'Otta',
          distanceKm: 140,
          durationMin: 120,
          slot: 'midday',
        },
      }),
      day({
        index: 3,
        overnight: { name: 'Dombas', lat: 0, lng: 0, country: 'NO' },
        drive: {
          fromName: 'Otta',
          toName: 'Dombas',
          distanceKm: 150,
          durationMin: 130,
          slot: 'midday',
        },
      }),
    ]

    expect(validatePacing(days, 4)).toBeNull()
  })

  it('allows a single long day driven to reach a worthwhile stop, as long as it stays within tolerance of the requested max drive hours', () => {
    const days: TripDay[] = [
      day({
        index: 0,
        drive: {
          fromName: 'A',
          toName: 'B',
          distanceKm: 100,
          durationMin: 90,
          slot: 'morning',
        },
      }),
      day({
        index: 1,
        drive: {
          fromName: 'B',
          toName: 'C',
          distanceKm: 291,
          durationMin: 291,
          slot: 'morning',
        },
        highlightReason: 'Detour to a must-see fjord viewpoint.',
      }),
    ]

    // maxDriveHoursPerDay=4 (240min) x 1.5 tolerance = 360min — day 1's
    // 291min fits, even though it's far above day 0's own distance/time.
    expect(validatePacing(days, 4)).toBeNull()
  })

  it('rejects a day that drives more than 1.5x the requested max drive hours', () => {
    const days: TripDay[] = [
      day({
        index: 0,
        drive: {
          fromName: 'A',
          toName: 'B',
          distanceKm: 100,
          durationMin: 90,
          slot: 'morning',
        },
      }),
      day({
        index: 1,
        drive: {
          fromName: 'B',
          toName: 'C',
          distanceKm: 500,
          durationMin: 400,
          slot: 'morning',
        },
      }),
    ]

    const violation = validatePacing(days, 4)
    expect(violation).not.toBeNull()
    expect(violation?.reason).toContain('4h/day max')
  })

  it('rejects a rest day placed in a fresh transit town', () => {
    const days: TripDay[] = [
      day({
        index: 0,
        overnight: { name: 'Lillehammer', lat: 0, lng: 0, country: 'NO' },
        drive: {
          fromName: 'Oslo',
          toName: 'Lillehammer',
          distanceKm: 180,
          durationMin: 150,
          slot: 'morning',
        },
      }),
      day({
        index: 1,
        type: 'rest',
        overnight: { name: 'Otta', lat: 0, lng: 0, country: 'NO' },
      }),
    ]

    const violation = validatePacing(days, 4)
    expect(violation).not.toBeNull()
    expect(violation?.reason).toContain('rest day')
  })
})

function driveDay(index: number, toName: string, distanceKm: number): TripDay {
  return day({
    index,
    overnight: { name: toName, lat: 0, lng: 0, country: 'SE' },
    drive: {
      fromName: 'wherever',
      toName,
      distanceKm,
      durationMin: distanceKm,
      slot: 'evening',
    },
  })
}

/** `count` drive days of `distanceKm` each, numbered from `from`. */
function evenDays(from: number, count: number, distanceKm: number): TripDay[] {
  return Array.from({ length: count }, (_, i) =>
    driveDay(from + i, `Stop ${from + i}`, distanceKm),
  )
}

describe('pacingWarnings', () => {
  // The trip that prompted this: Helsingborg to Berlin, with the start of the
  // trip spent near the start of the trip and the distance never made up
  // until the end. The complaint was never that a day was short — it was
  // that the shortness was paid for all at once, at the finish.
  it('flags a trip that spends its start and then has to make it up', () => {
    const warnings = pacingWarnings([
      driveDay(0, 'Helsingor', 30),
      driveDay(1, 'Koge', 40),
      driveDay(2, 'Rostock', 320),
      driveDay(3, 'Waren', 320),
      driveDay(4, 'Berlin', 320),
    ])

    expect(warnings).toHaveLength(1)
    // Day 2 is where the required pace peaks — after day 1 the trip could
    // still have absorbed it.
    expect(warnings[0]).toContain('day 2')
    expect(warnings[0]).toContain('km a day left to drive')
  })

  // The whole point of the rework. A two-month trip is mostly short days and
  // long stays, and none of them owe anybody a distance.
  it('says nothing about a long trip full of short days, as long as they stay balanced', () => {
    expect(pacingWarnings(evenDays(0, 40, 60))).toEqual([])
  })

  // A day at a fifth of the average used to be flagged on its own. It is
  // only a problem if the trip never recovers from it.
  it('accepts a near-zero day that the rest of the trip absorbs', () => {
    const warnings = pacingWarnings([
      driveDay(0, 'Just up the road', 15),
      ...evenDays(1, 9, 205),
    ])

    expect(warnings).toEqual([])
  })

  it('accepts several short days in a row when the trip can still afford them', () => {
    const warnings = pacingWarnings([
      driveDay(0, 'A', 40),
      driveDay(1, 'B', 40),
      driveDay(2, 'C', 40),
      ...evenDays(3, 20, 212),
    ])

    expect(warnings).toEqual([])
  })

  // One long final day is a long final day, not a slog — validatePacing
  // already bounds it by the traveler's own stated maximum.
  it('does not call a single long finish a backlog', () => {
    expect(
      pacingWarnings([...evenDays(0, 6, 200), driveDay(6, 'Home', 600)]),
    ).toEqual([])
  })

  // On three drive days one stop legitimately is a third of the trip.
  it('stays quiet on a trip too short to have a distribution', () => {
    expect(
      pacingWarnings([
        driveDay(0, 'A', 20),
        driveDay(1, 'B', 400),
        driveDay(2, 'C', 400),
      ]),
    ).toEqual([])
  })

  // Rest days are supposed to stay put — counting them as zero-distance days
  // would drag the average down and make every real day look excessive.
  it('ignores rest days entirely', () => {
    const days = [
      ...evenDays(0, 3, 200),
      day({ index: 3, type: 'rest', overnight: { name: 'A', lat: 0, lng: 0, country: 'SE' } }),
      ...evenDays(4, 3, 200),
    ]
    expect(pacingWarnings(days)).toEqual([])
  })

  it('reports the worst point once, not every day that contributed to it', () => {
    const warnings = pacingWarnings([
      driveDay(0, 'A', 20),
      driveDay(1, 'B', 20),
      driveDay(2, 'C', 20),
      ...evenDays(3, 5, 340),
    ])

    expect(warnings).toHaveLength(1)
    // Day 3 is where the remaining pace peaks, not day 1 where it first rose.
    expect(warnings[0]).toContain('day 3')
  })
})
