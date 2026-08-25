import { describe, expect, it } from 'vitest'
import { buildDaySectionPrompt } from './daySectionPrompt.js'
import { buildChunkDetailPrompt } from './planTripPrompt.js'
import type { TripSettings } from '@rv/shared'

const SETTINGS = {
  startDate: '2026-07-10',
  endDate: '2026-07-20',
  startPoint: { name: 'Oslo', lat: 59.91, lng: 10.75 },
  endPoint: { name: 'Rome', lat: 41.9, lng: 12.5 },
  interests: ['mountain biking'],
  maxDriveHoursPerDay: 5,
} as unknown as TripSettings

const DAY = {
  index: 0,
  date: '2026-07-10',
  type: 'drive' as const,
  overnight: { town: 'Bolzano', name: 'Bolzano', country: 'IT' },
  highlightReason: 'Gateway to the Seiser Alm.',
  sights: ['Seiser Alm'],
}

function build(over: Partial<Parameters<typeof buildDaySectionPrompt>[0]> = {}) {
  return buildDaySectionPrompt({
    settings: SETTINGS,
    notesFreeText: 'cozy over mainstream',
    day: DAY,
    kind: 'activity',
    existingNames: [],
    ...over,
  })
}

describe('the one-section prompt', () => {
  it('asks for activities when that is what was clicked', () => {
    const { system } = build({ kind: 'activity' })
    expect(system).toContain('5 activities')
    expect(system).toContain('"activities"')
    expect(system).not.toContain('"restaurants"')
  })

  it('asks for one meal when that is what was clicked', () => {
    const { system } = build({ kind: 'restaurant', meal: 'lunch' })
    expect(system).toContain('3 places for lunch')
    expect(system).toContain('"meal": "lunch"')
    expect(system).not.toContain('"activities"')
  })

  /**
   * The reason this goes to Claude at all. `researchMoreAlternatives` fills
   * sections from Places' top-rated-nearby with a template sentence, and
   * that is exactly what produced "the descriptions for activities seem to
   * have become quite generic" on 2026-08-18. If this rule ever drifts out
   * of one prompt and not the other, the two paths start producing visibly
   * different writing for the same screen.
   */
  it('carries the same anti-generic-blurb rule as the whole-trip prompt', () => {
    const section = build().system
    const wholeTrip = buildChunkDetailPrompt({
      settings: SETTINGS,
      notesFreeText: '',
      outline: { days: [DAY] },
      chunkDays: [DAY],
    }).system

    for (const phrase of [
      '2-3 real sentences',
      'A well-rated local hike.',
      'indistinguishable from a failure',
    ]) {
      expect(section, `section prompt: ${phrase}`).toContain(phrase)
      expect(wholeTrip, `whole-trip prompt: ${phrase}`).toContain(phrase)
    }
  })

  it('tells the model what is already on the day so it does not repeat it', () => {
    const { system, user } = build({ existingNames: ['Osteria Vecchia'] })
    expect(system).toContain('alreadyOnThisDay')
    expect(JSON.parse(user).alreadyOnThisDay).toEqual(['Osteria Vecchia'])
  })

  // The stop the day exists for. Without it the suggestions drift away from
  // the reason the traveler is in that town at all.
  it('passes the day’s own sights through', () => {
    const { user } = build()
    expect(JSON.parse(user).day.sights).toEqual(['Seiser Alm'])
  })

  it('forbids inventing ratings and hours, which Places resolves', () => {
    expect(build().system).toContain('Do NOT invent')
  })
})
