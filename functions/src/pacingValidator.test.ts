import { describe, expect, it } from 'vitest'
import type { TripDay } from '@rv/shared'
import { validatePacing } from './pacingValidator.js'

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

  it('rejects a day that drives more than 1.4x the target', () => {
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

    const violation = validatePacing(days)
    expect(violation).not.toBeNull()
    expect(violation?.reason).toContain('1.4x')
  })

  it('rejects a monster final day', () => {
    const days: TripDay[] = [
      day({
        index: 0,
        drive: {
          fromName: 'A',
          toName: 'B',
          distanceKm: 150,
          durationMin: 120,
          slot: 'morning',
        },
      }),
      day({
        index: 1,
        drive: {
          fromName: 'B',
          toName: 'C',
          distanceKm: 150,
          durationMin: 120,
          slot: 'morning',
        },
      }),
      day({
        index: 2,
        drive: {
          fromName: 'C',
          toName: 'D',
          distanceKm: 200,
          durationMin: 170,
          slot: 'morning',
        },
      }),
    ]

    const violation = validatePacing(days)
    expect(violation).not.toBeNull()
    expect(violation?.reason).toContain('relaxed finish')
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

    const violation = validatePacing(days)
    expect(violation).not.toBeNull()
    expect(violation?.reason).toContain('rest day')
  })
})
