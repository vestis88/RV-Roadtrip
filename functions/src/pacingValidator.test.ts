import { describe, expect, it } from 'vitest'
import type { TripDay } from '@rv/shared'
import { driveLengthWarnings, pacingWarnings, validatePacing } from './pacingValidator.js'

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

    expect(validatePacing(days)).toBeNull()
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
    expect(driveLengthWarnings(days, 4)).toEqual([])
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

    /**
     * This asserted a REJECTION until 2026-08-23, and the change is the
     * point of the phase: a day longer than the traveler asked for is a
     * preference of theirs being exceeded, not a malformed plan. It cost
     * the whole write on the incremental path — one stop added, one day
     * made long, entire edit discarded — which is what "less strict about
     * pace/exact days" was about.
     */
    expect(validatePacing(days)).toBeNull()

    const warnings = driveLengthWarnings(days, 4)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('4h/day you asked for')
    // Day numbers read as the traveler sees them, not as the index.
    expect(warnings[0]).toContain('Day 2')
  })

  it('says nothing about drive length when no limit is known', () => {
    expect(driveLengthWarnings([], undefined)).toEqual([])
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

    // Still a hard failure, and deliberately so: a rest day that teleports
    // to a fresh transit town is malformed wherever it was built, which is
    // why this half stayed in validatePacing when the drive-length half
    // became advice.
    const violation = validatePacing(days)
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

describe('pacingWarnings — sight load (rule 7)', () => {
  const CASTLE = new Map<string, 'full-day' | 'half-day' | 'couple-of-hours'>([
    ['Kronborg Castle', 'full-day'],
    ['Frederiksborg Castle', 'full-day'],
    ['Louisiana Museum', 'half-day'],
    ['Rundetaarn', 'couple-of-hours'],
  ])

  /** Six even 200 km days: the trip average is 200 km. */
  function evenTrip(): TripDay[] {
    return evenDays(0, 6, 200)
  }

  it('says nothing when no day carries a sight', () => {
    expect(pacingWarnings(evenTrip(), CASTLE)).toEqual([])
  })

  it('flags a full-day sight scheduled behind a full day of driving', () => {
    const days = evenTrip()
    days[2] = { ...days[2], sights: ['Kronborg Castle'] }

    const warnings = pacingWarnings(days, CASTLE)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('Kronborg Castle')
    expect(warnings[0]).toContain('full-day')
    // 200 km driven against the 100 km a full-day sight leaves room for.
    expect(warnings[0]).toContain('200 km')
    expect(warnings[0]).toContain('100 km')
  })

  it('accepts the same sight on a short day', () => {
    const days = evenTrip()
    days[2] = { ...driveDay(2, 'Helsingor', 60), sights: ['Kronborg Castle'] }

    expect(pacingWarnings(days, CASTLE)).toEqual([])
  })

  // Exactly what rule 7 asks for: give the full-day sight a day that drives
  // nothing at all.
  it('accepts a full-day sight on a rest day', () => {
    const days = evenTrip()
    days[2] = day({
      index: 2,
      type: 'rest',
      overnight: { name: 'Stop 2', lat: 0, lng: 0, country: 'SE' },
      sights: ['Kronborg Castle'],
    })

    expect(pacingWarnings(days, CASTLE)).toEqual([])
  })

  it('flags two full-day sights on one day even where the driving is fine', () => {
    const days = evenTrip()
    days[2] = {
      ...driveDay(2, 'Helsingor', 10),
      sights: ['Kronborg Castle', 'Frederiksborg Castle'],
    }

    const warnings = pacingWarnings(days, CASTLE)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('Kronborg Castle and Frederiksborg Castle')
  })

  // The heaviest sight sets the allowance — a full day doesn't get cheaper
  // because something quick is scheduled beside it.
  it('paces a mixed day against its heaviest sight', () => {
    const days = evenTrip()
    days[2] = {
      ...driveDay(2, 'Helsingor', 190),
      sights: ['Rundetaarn', 'Kronborg Castle'],
    }

    const warnings = pacingWarnings(days, CASTLE)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('Kronborg Castle')
  })

  it('leaves a couple-of-hours sight to the ordinary per-day ceiling', () => {
    const days = evenTrip()
    days[2] = { ...driveDay(2, 'Kobenhavn', 260), sights: ['Rundetaarn'] }

    expect(pacingWarnings(days, CASTLE)).toEqual([])
  })

  // A sight the traveler added themselves has no estimate; rule 7 reads that
  // as half a day rather than as no constraint at all.
  it('treats a sight with no estimate as a half-day', () => {
    const days = evenTrip()
    days[2] = { ...driveDay(2, 'Somewhere', 260), sights: ['A place they added'] }

    const warnings = pacingWarnings(days, CASTLE)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('half-day')
  })

  it('reports each offending day, since each has its own fix', () => {
    const days = evenTrip()
    days[1] = { ...days[1], sights: ['Kronborg Castle'] }
    days[4] = { ...days[4], sights: ['Frederiksborg Castle'] }

    expect(pacingWarnings(days, CASTLE)).toHaveLength(2)
  })
})
