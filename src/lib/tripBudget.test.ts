import { describe, expect, it } from 'vitest'
import { describeBudget, tripBudget } from './tripBudget'

const BASE = {
  startDate: '2026-07-01',
  endDate: '2026-07-14', // 14 days inclusive
  maxDriveHoursPerDay: 5,
}

describe('tripBudget', () => {
  /**
   * The design decision the whole feature rests on. sum(stay) + sum(drive)
   * is not a trip length — you cannot do a full-day sight AND a six-hour
   * drive on the same day, which is why maxDriveHoursPerDay exists at all.
   * "84 h 20 min" cannot be curated against; "~11 days, you have 14" can.
   */
  it('packs into days rather than summing hours', () => {
    // 20h of driving at 5h/day is 4 days of driving, no matter that the
    // raw hours would divide into fewer.
    const budget = tripBudget({
      ...BASE,
      stops: [{ timeNeeded: 'couple-of-hours' }],
      legs: [{ durationMin: 20 * 60 }],
    })
    expect(budget.daysNeeded).toBe(4)
    expect(budget.driveMinutes).toBe(1200)
  })

  it('lets daylight bind when driving alone would fit', () => {
    // 4h of driving is under one day's limit, but three full-day sights on
    // top of it is not one day's worth of daylight.
    const budget = tripBudget({
      ...BASE,
      stops: [
        { timeNeeded: 'full-day' },
        { timeNeeded: 'full-day' },
        { timeNeeded: 'full-day' },
      ],
      legs: [{ durationMin: 4 * 60 }],
    })
    expect(budget.stayHours).toBe(24)
    // (24 + 4) / 10 usable hours = 2.8 → 3
    expect(budget.daysNeeded).toBe(3)
  })

  // The reason duration is not just a number of hours: a basecamp costs
  // whole days and nothing else can be scheduled into them.
  it('counts basecamp nights as days on top of the moving days', () => {
    const budget = tripBudget({
      ...BASE,
      stops: [{ stayDuration: { kind: 'nights', nights: 3 } }],
      legs: [{ durationMin: 5 * 60 }],
    })
    expect(budget.nightsAtStops).toBe(3)
    expect(budget.stayHours).toBe(0)
    // One day of driving, plus three parked.
    expect(budget.daysNeeded).toBe(4)
  })

  it('takes an explicit hours override over the timeNeeded estimate', () => {
    const budget = tripBudget({
      ...BASE,
      stops: [{ timeNeeded: 'couple-of-hours', stayDuration: { kind: 'hours', hours: 6 } }],
    })
    expect(budget.stayHours).toBe(6)
  })

  it('falls back to the curation estimate when nothing was set', () => {
    expect(tripBudget({ ...BASE, stops: [{ timeNeeded: 'full-day' }] }).stayHours).toBe(8)
    expect(tripBudget({ ...BASE, stops: [{}] }).stayHours).toBe(4)
  })

  // The number is "what's left", which is what makes it useful on the road.
  it('excludes stops already marked done', () => {
    const budget = tripBudget({
      ...BASE,
      stops: [
        { timeNeeded: 'full-day', doneAt: '2026-07-02T10:00:00.000Z' },
        { timeNeeded: 'full-day' },
      ],
    })
    expect(budget.stayHours).toBe(8)
  })

  it('reports spare days against the trip’s own dates', () => {
    const budget = tripBudget({
      ...BASE,
      stops: [{ timeNeeded: 'couple-of-hours' }],
    })
    expect(budget.daysAvailable).toBe(14)
    expect(budget.spareDays).toBe(13)
  })

  it('goes negative when the stops do not fit', () => {
    const budget = tripBudget({
      startDate: '2026-07-01',
      endDate: '2026-07-03', // 3 days
      maxDriveHoursPerDay: 5,
      stops: [{ stayDuration: { kind: 'nights', nights: 6 } }],
    })
    expect(budget.spareDays).toBeLessThan(0)
  })

  it('is zero days for a trip with nothing locked', () => {
    const budget = tripBudget({ ...BASE, stops: [] })
    expect(budget.daysNeeded).toBe(0)
    expect(budget.spareDays).toBe(14)
  })

  // Half a day of driving still costs a day of the calendar.
  it('never reports less than a day for a trip with anything in it', () => {
    const budget = tripBudget({
      ...BASE,
      stops: [],
      legs: [{ durationMin: 30 }],
    })
    expect(budget.daysNeeded).toBe(1)
  })

  // The board shows this before Google has answered.
  it('works with no legs at all', () => {
    const budget = tripBudget({ ...BASE, stops: [{ timeNeeded: 'full-day' }] })
    expect(budget.driveMinutes).toBe(0)
    expect(budget.daysNeeded).toBe(1)
  })

  it('counts a same-day trip as one day, not zero', () => {
    const budget = tripBudget({
      startDate: '2026-07-01',
      endDate: '2026-07-01',
      maxDriveHoursPerDay: 5,
      stops: [],
    })
    expect(budget.daysAvailable).toBe(1)
  })
})

describe('describeBudget', () => {
  it('leads with the choices, then the cost, then the room left', () => {
    const said = describeBudget(
      tripBudget({ ...BASE, stops: [{ timeNeeded: 'full-day' }] }),
      1,
    )
    expect(said).toBe('1 stop · ~1 day · 13 spare')
  })

  // "3 days over" is actionable; "-3 days spare" is arithmetic.
  it('states an overrun as a shortfall rather than a negative', () => {
    const budget = tripBudget({
      startDate: '2026-07-01',
      endDate: '2026-07-03',
      maxDriveHoursPerDay: 5,
      stops: [{ stayDuration: { kind: 'nights', nights: 6 } }],
    })
    expect(describeBudget(budget, 1)).toContain('3 days over')
    expect(describeBudget(budget, 1)).not.toContain('-')
  })

  it('says nothing about spare days on a trip with no dates', () => {
    const budget = tripBudget({
      startDate: '',
      endDate: '',
      maxDriveHoursPerDay: 5,
      stops: [{ timeNeeded: 'full-day' }],
    })
    expect(describeBudget(budget, 1)).toBe('1 stop · ~1 day')
  })
})
