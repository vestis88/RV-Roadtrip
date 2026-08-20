import { describe, expect, it } from 'vitest'
import { haversineDistanceKm, isTripActiveToday } from './executionMode'

describe('haversineDistanceKm', () => {
  it('is ~0 for the same point', () => {
    const oslo = { lat: 59.9139, lng: 10.7522 }
    expect(haversineDistanceKm(oslo, oslo)).toBeCloseTo(0, 3)
  })

  it('matches the known Oslo -> Lillehammer distance (~110 km great-circle)', () => {
    const oslo = { lat: 59.9139, lng: 10.7522 }
    const lillehammer = { lat: 61.1153, lng: 10.4662 }
    const distance = haversineDistanceKm(oslo, lillehammer)
    expect(distance).toBeGreaterThan(100)
    expect(distance).toBeLessThan(140)
  })
})

describe('isTripActiveToday', () => {
  it('is active when today is within [startDate, endDate]', () => {
    expect(isTripActiveToday('2026-07-11', '2026-07-10', '2026-07-15')).toBe(
      true,
    )
  })

  it('is inactive before the trip starts', () => {
    expect(isTripActiveToday('2026-07-01', '2026-07-10', '2026-07-15')).toBe(
      false,
    )
  })

  it('is inactive after the trip ends', () => {
    expect(isTripActiveToday('2026-07-20', '2026-07-10', '2026-07-15')).toBe(
      false,
    )
  })
})
