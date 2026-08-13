import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OFF_GRID_TOLERANCE,
  activitySchema,
  countryGuideSectionSchema,
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
