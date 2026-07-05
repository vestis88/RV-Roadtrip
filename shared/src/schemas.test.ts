import { describe, expect, it } from 'vitest'
import {
  activitySchema,
  countryGuideSchema,
  logEntrySchema,
  planRequestSchema,
  restaurantSchema,
  tripDaySchema,
  tripSchema,
} from './schemas.js'
import {
  fixtureActivity,
  fixtureCountryGuide,
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

  it('validates a country guide document', () => {
    expect(countryGuideSchema.parse(fixtureCountryGuide)).toEqual(
      fixtureCountryGuide,
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
})
