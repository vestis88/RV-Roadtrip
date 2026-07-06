import { describe, expect, it } from 'vitest'
import { getZoomTiers } from './mapZoomTiers'

describe('getZoomTiers', () => {
  it('shows only the route at zoom 5 (z < 6)', () => {
    expect(getZoomTiers(5)).toEqual({
      showOvernightStops: false,
      showSelectedActivities: false,
      showAllPlaces: false,
    })
  })

  it('adds overnight stops at zoom 7 (6-8)', () => {
    expect(getZoomTiers(7)).toEqual({
      showOvernightStops: true,
      showSelectedActivities: false,
      showAllPlaces: false,
    })
  })

  it('adds selected activities at zoom 10 (9-11)', () => {
    expect(getZoomTiers(10)).toEqual({
      showOvernightStops: true,
      showSelectedActivities: true,
      showAllPlaces: false,
    })
  })

  it('shows everything at zoom 13 (>=12)', () => {
    expect(getZoomTiers(13)).toEqual({
      showOvernightStops: true,
      showSelectedActivities: true,
      showAllPlaces: true,
    })
  })
})
