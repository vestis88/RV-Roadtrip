import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OFF_GRID_TOLERANCE,
  activitySchema,
  countryGuideSectionSchema,
  MAX_DETAIL_WINDOW_DAYS,
  DEFAULT_DETAIL_WINDOW_DAYS,
  detailWindowDaysOf,
  offGridToleranceOf,
  logEntrySchema,
  planRequestSchema,
  restaurantSchema,
  tripDaySchema,
  tripSchema,
} from './schemas.js'
import {
  fixtureActivity,
  fixtureCountryGuideSection,
  fixtureDay,
  fixtureLogEntry,
  fixturePlanRequest,
  fixtureRestaurant,
  fixtureTrip,
} from './fixtures.js'

describe('fixture trip validates against every schema', () => {
  it('validates the trip document', () => {
    expect(tripSchema.parse(fixtureTrip)).toEqual(fixtureTrip)
  })

  it('validates a trip day document', () => {
    expect(tripDaySchema.parse(fixtureDay)).toEqual(fixtureDay)
  })

  it('validates an activity document', () => {
    expect(activitySchema.parse(fixtureActivity)).toEqual(fixtureActivity)
  })

  it('validates a restaurant document', () => {
    expect(restaurantSchema.parse(fixtureRestaurant)).toEqual(
      fixtureRestaurant,
    )
  })

  it('validates a researched country guide section', () => {
    expect(countryGuideSectionSchema.parse(fixtureCountryGuideSection)).toEqual(
      fixtureCountryGuideSection,
    )
  })

  it('validates a log entry document', () => {
    expect(logEntrySchema.parse(fixtureLogEntry)).toEqual(fixtureLogEntry)
  })

  it('validates a plan request document', () => {
    expect(planRequestSchema.parse(fixturePlanRequest)).toEqual(
      fixturePlanRequest,
    )
  })
})

describe('off-grid tolerance', () => {
  // Every trip that existed before the setting did has no value stored, and
  // must keep validating — which is also the reason the default lives in one
  // function instead of a `?? 3` at each reader.
  it('validates a trip whose settings predate the setting', () => {
    expect(fixtureTrip.settings).not.toHaveProperty('offGridTolerance')
    expect(tripSchema.parse(fixtureTrip)).toEqual(fixtureTrip)
    expect(offGridToleranceOf(fixtureTrip.settings)).toBe(
      DEFAULT_OFF_GRID_TOLERANCE,
    )
  })

  // 0 is a real answer — "give me facilities every night" — not an absent one.
  it('keeps a stored zero rather than defaulting it away', () => {
    expect(offGridToleranceOf({ offGridTolerance: 0 })).toBe(0)
  })

  it('rejects a fractional or negative number of nights', () => {
    for (const offGridTolerance of [1.5, -1]) {
      expect(() =>
        tripSchema.parse({
          ...fixtureTrip,
          settings: { ...fixtureTrip.settings, offGridTolerance },
        }),
      ).toThrow()
    }
  })
})

describe('schema rejects invalid data', () => {
  it('rejects a trip with an out-of-range rating on an activity', () => {
    expect(() =>
      activitySchema.parse({ ...fixtureActivity, rating: 6 }),
    ).toThrow()
  })

  it('rejects a trip settings block with a bad country code', () => {
    expect(() =>
      tripSchema.parse({
        ...fixtureTrip,
        settings: {
          ...fixtureTrip.settings,
          preferredCountries: ['Norway'],
        },
      }),
    ).toThrow()
  })

  it('rejects a vehicle with an unrecognized fuel type', () => {
    expect(() =>
      tripSchema.parse({
        ...fixtureTrip,
        settings: {
          ...fixtureTrip.settings,
          vehicle: { ...fixtureTrip.settings.vehicle, fuel: 'hydrogen' },
        },
      }),
    ).toThrow()
  })
})

// Added 2026-08-17: "I want the option to decide how many days ahead it
// should plan as a slider in trip setup." The number sizes paid work — a
// Claude call and a run of Places lookups per day — and it arrives from a
// client write, so it is clamped rather than trusted.
describe('detailWindowDaysOf', () => {
  it('defaults for a trip that predates the setting', () => {
    expect(detailWindowDaysOf({})).toBe(DEFAULT_DETAIL_WINDOW_DAYS)
  })

  it('takes the traveler at their word inside the range', () => {
    expect(detailWindowDaysOf({ detailWindowDays: 1 })).toBe(1)
    expect(detailWindowDaysOf({ detailWindowDays: 10 })).toBe(10)
    expect(detailWindowDaysOf({ detailWindowDays: MAX_DETAIL_WINDOW_DAYS })).toBe(
      MAX_DETAIL_WINDOW_DAYS,
    )
  })

  // Past the ceiling the window stops being a window and becomes the thing
  // the eager/lazy split was built to stop.
  it('clamps a value that would detail the whole trip up front', () => {
    expect(detailWindowDaysOf({ detailWindowDays: 60 })).toBe(
      MAX_DETAIL_WINDOW_DAYS,
    )
  })

  // Zero days of detail is not a setting, it is a plan with nothing in it.
  it('never returns less than a day', () => {
    expect(detailWindowDaysOf({ detailWindowDays: 0 })).toBe(1)
    expect(detailWindowDaysOf({ detailWindowDays: -5 })).toBe(1)
  })

  it('rounds a fractional value rather than passing it to a slice', () => {
    expect(detailWindowDaysOf({ detailWindowDays: 3.6 })).toBe(4)
  })
})
