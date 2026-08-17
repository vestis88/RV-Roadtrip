import { describe, expect, it } from 'vitest'
import type { TripDay } from '@rv/shared'
import { outlineFromDays } from './dayOutline.js'
import { routeOutlineSchema } from './prompts/planTripSchema.js'

function day(overrides: Partial<TripDay> = {}): TripDay {
  return {
    index: 0,
    date: '2026-07-10',
    type: 'drive',
    overnight: { name: 'Sunne', lat: 59.8, lng: 13.1, country: 'SE' },
    summary: 'A day around Sunne.',
    highlightReason: 'For the bike park.',
    ...overrides,
  }
}

/**
 * Detailing a day later has no outline object to hand — by then the route
 * exists only as the days themselves. A reconstruction that drifts means a
 * detail call reasoning about a different trip from the one being planned.
 */
describe('outlineFromDays', () => {
  it('produces something the outline schema itself accepts', () => {
    expect(() => routeOutlineSchema.parse(outlineFromDays([day()]))).not.toThrow()
  })

  it('orders by index regardless of the order it was handed', () => {
    const outline = outlineFromDays([
      day({ index: 2, date: '2026-07-12' }),
      day({ index: 0 }),
      day({ index: 1, date: '2026-07-11' }),
    ])
    expect(outline.days.map((d) => d.index)).toEqual([0, 1, 2])
  })

  // applyOvernightOptions rewrites lat/lng and adds campsiteSuggestion but
  // never touches `name`, which is what makes it safe as the town here. If
  // that ever changes, this is the test that should fail.
  it('uses the town name, not the campsite the night was moved to', () => {
    const outline = outlineFromDays([
      day({
        overnight: {
          name: 'Sunne',
          lat: 59.81,
          lng: 13.12,
          country: 'SE',
          campsiteSuggestion: 'Sunne Camping',
        },
      }),
    ])
    expect(outline.days[0].overnight.town).toBe('Sunne')
    expect(outline.days[0].overnight.name).toBe('Sunne')
    expect(outline.days[0].overnight.campsiteSuggestion).toBe('Sunne Camping')
  })

  it('carries the drive leg back as towns and a slot', () => {
    const outline = outlineFromDays([
      day({
        drive: {
          fromName: 'Laholm',
          toName: 'Sunne',
          distanceKm: 300,
          durationMin: 240,
          slot: 'morning',
        },
      }),
    ])
    expect(outline.days[0].drive).toEqual({
      fromTown: 'Laholm',
      toTown: 'Sunne',
      slot: 'morning',
    })
  })

  it('omits drive entirely for a rest day', () => {
    const outline = outlineFromDays([day({ type: 'rest', drive: undefined })])
    expect(outline.days[0]).not.toHaveProperty('drive')
  })

  // highlightReason is required by the outline schema and optional on a day,
  // because days written before it existed have none.
  it('falls back to the summary when a day predates highlightReason', () => {
    const outline = outlineFromDays([
      day({ highlightReason: undefined, summary: 'A day around Sunne.' }),
    ])
    expect(outline.days[0].highlightReason).toBe('A day around Sunne.')
    expect(() => routeOutlineSchema.parse(outline)).not.toThrow()
  })

  // A malformed legacy day must not be able to fail the detail call for the
  // days around it, so there is a last resort below the summary.
  it('still yields a valid outline when a day has neither', () => {
    const outline = outlineFromDays([
      day({ highlightReason: '  ', summary: '' } as Partial<TripDay>),
    ])
    expect(outline.days[0].highlightReason).toBe('Overnight in Sunne.')
    expect(() => routeOutlineSchema.parse(outline)).not.toThrow()
  })

  it('keeps the sights a day was routed for', () => {
    const outline = outlineFromDays([day({ sights: ['Sunne Bike Park'] })])
    expect(outline.days[0].sights).toEqual(['Sunne Bike Park'])
  })
})
