import { describe, expect, it } from 'vitest'
import { hasRoute } from './validateRoute'

const BLANK = { name: '', lat: 0, lng: 0 }
const OSLO = { name: 'Oslo, Norway', lat: 59.91, lng: 10.75 }
const BERGEN = { name: 'Bergen, Norway', lat: 60.39, lng: 5.32 }

describe('hasRoute', () => {
  it('is true when both start and end points are named', () => {
    expect(hasRoute({ startPoint: OSLO, endPoint: BERGEN })).toBe(true)
  })

  it('is false when the end point is still blank (new-trip default)', () => {
    expect(hasRoute({ startPoint: OSLO, endPoint: BLANK })).toBe(false)
  })

  it('is false when the start point is still blank', () => {
    expect(hasRoute({ startPoint: BLANK, endPoint: BERGEN })).toBe(false)
  })

  it('is false when both are blank', () => {
    expect(hasRoute({ startPoint: BLANK, endPoint: BLANK })).toBe(false)
  })

  it('is false for a name that is only whitespace', () => {
    expect(hasRoute({ startPoint: { ...OSLO, name: '   ' }, endPoint: BERGEN })).toBe(
      false,
    )
  })
})

// Regression: PlaceAutocompleteInput accepts a typed name straight away and
// resolves its coordinates asynchronously, so a point can carry a real name
// while still sitting on the (0, 0) sentinel — permanently, if that lookup
// fails. Checking the name alone let generation route the trip at the
// equator, the very outcome this guard was written to stop.
describe('hasRoute — named but unlocated points', () => {
  const NAMED_AT_ORIGIN = { name: 'Bergen, Norway', lat: 0, lng: 0 }

  it('is false when the start is named but still on the (0,0) sentinel', () => {
    expect(hasRoute({ startPoint: NAMED_AT_ORIGIN, endPoint: BERGEN })).toBe(false)
  })

  it('is false when the finish is named but still on the (0,0) sentinel', () => {
    expect(hasRoute({ startPoint: OSLO, endPoint: NAMED_AT_ORIGIN })).toBe(false)
  })

  it('is false for non-finite coordinates', () => {
    expect(
      hasRoute({
        startPoint: { name: 'Somewhere', lat: Number.NaN, lng: 10 },
        endPoint: BERGEN,
      }),
    ).toBe(false)
  })

  it('stays true once real coordinates arrive', () => {
    expect(hasRoute({ startPoint: OSLO, endPoint: BERGEN })).toBe(true)
  })
})
