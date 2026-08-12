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

describe('pacingWarnings', () => {
  // The trip that prompted this: Helsingborg to Berlin, and two of its days
  // went to Helsingør — 45km away, across the sound — because something
  // interesting sat just past the start point. Nothing about it was invalid.
  it('flags a day that barely moves the trip along', () => {
    const warnings = pacingWarnings([
      driveDay(0, 'Helsingor', 45),
      driveDay(1, 'Rostock', 250),
      driveDay(2, 'Waren', 250),
      driveDay(3, 'Berlin', 250),
    ])

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('Day 1')
    expect(warnings[0]).toContain('45 km')
    expect(warnings[0]).toContain('Helsingor')
  })

  it('says nothing about a route whose days are all roughly even', () => {
    expect(
      pacingWarnings([
        driveDay(0, 'A', 180),
        driveDay(1, 'B', 220),
        driveDay(2, 'C', 200),
        driveDay(3, 'D', 210),
      ]),
    ).toEqual([])
  })

  // A short last day is the relaxed finish the generator is asked for, not a
  // wasted one — the trip has arrived.
  it('leaves the final arrival day alone', () => {
    expect(
      pacingWarnings([
        driveDay(0, 'A', 250),
        driveDay(1, 'B', 250),
        driveDay(2, 'Home', 20),
      ]),
    ).toEqual([])
  })

  // On two drive days every split looks lopsided, and the traveler can see
  // the whole trip at a glance anyway.
  it('stays quiet on a trip too short to have an average worth comparing to', () => {
    expect(pacingWarnings([driveDay(0, 'A', 20), driveDay(1, 'B', 400)])).toEqual(
      [],
    )
  })

  // Rest days are supposed to stay put — counting them as zero-distance days
  // would drag the average down and make every real day look excessive.
  it('ignores rest days entirely', () => {
    const warnings = pacingWarnings([
      driveDay(0, 'A', 200),
      day({ index: 1, type: 'rest', overnight: { name: 'A', lat: 0, lng: 0, country: 'SE' } }),
      driveDay(2, 'B', 200),
      driveDay(3, 'C', 200),
      driveDay(4, 'D', 200),
    ])
    expect(warnings).toEqual([])
  })

  it('flags every offending day, not just the first', () => {
    const warnings = pacingWarnings([
      driveDay(0, 'A', 20),
      driveDay(1, 'B', 300),
      driveDay(2, 'C', 25),
      driveDay(3, 'D', 300),
      driveDay(4, 'E', 300),
    ])
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toContain('Day 1')
    expect(warnings[1]).toContain('Day 3')
  })
})
