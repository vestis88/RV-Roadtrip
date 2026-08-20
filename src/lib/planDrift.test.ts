import { describe, expect, it } from 'vitest'
import {
  describePlanDrift,
  planDrift,
  shouldPromptReplan,
} from './planDrift'

// A straight north-bound trip, ~111 km between each night.
const START = { lat: 55, lng: 12 }
const NIGHTS = [
  { date: '2026-07-10', overnight: { lat: 56, lng: 12 } },
  { date: '2026-07-11', overnight: { lat: 57, lng: 12 } },
  { date: '2026-07-12', overnight: { lat: 58, lng: 12 } },
  { date: '2026-07-13', overnight: { lat: 59, lng: 12 } },
]

function driftAt(today: string, here: { lat: number; lng: number }) {
  return planDrift({ start: START, nights: NIGHTS, today, here })
}

describe('planDrift', () => {
  it('reads zero when the traveler is where tonight ends', () => {
    const drift = driftAt('2026-07-11', { lat: 57, lng: 12 })
    expect(Math.abs(drift!.behindKm)).toBeLessThan(1)
  })

  // The failure the old check could not express: 60 km PAST tonight's town
  // measured the same as 60 km short of it.
  it('goes negative when the traveler is ahead of the plan', () => {
    const drift = driftAt('2026-07-11', { lat: 57.5, lng: 12 })
    expect(drift!.behindKm).toBeLessThan(0)
    expect(shouldPromptReplan(drift)).toBe(false)
  })

  it('measures a real shortfall as behind', () => {
    const drift = driftAt('2026-07-11', { lat: 56, lng: 12 })
    expect(drift!.behindKm).toBeGreaterThan(100)
    expect(shouldPromptReplan(drift)).toBe(true)
  })

  // Halfway between two nights is halfway, not "at the nearer town" — which
  // is what measuring to the nearest vertex would have said.
  it('counts progress part-way along a leg', () => {
    const half = driftAt('2026-07-11', { lat: 56.5, lng: 12 })
    const atPrevious = driftAt('2026-07-11', { lat: 56, lng: 12 })
    expect(half!.behindKm).toBeGreaterThan(0)
    expect(half!.behindKm).toBeLessThan(atPrevious!.behindKm * 0.75)
  })

  it('expresses the gap in the pace of the days that are left', () => {
    // One whole night short, on a plan whose remaining nights are one night
    // apart — so about one day behind.
    const drift = driftAt('2026-07-11', { lat: 56, lng: 12 })
    expect(drift!.behindDays).toBeGreaterThan(0.7)
    expect(drift!.behindDays).toBeLessThan(1.4)
  })

  it('says nothing about a date that is not one of the plan’s days', () => {
    expect(driftAt('2026-09-01', { lat: 56, lng: 12 })).toBeNull()
  })
})

describe('shouldPromptReplan', () => {
  it('stays quiet for a gap that is small in absolute terms', () => {
    expect(shouldPromptReplan({ behindKm: 20, behindDays: 2 })).toBe(false)
  })

  // The other half of the pair: 60 km is nothing on a trip whose remaining
  // days average 400, and the old single threshold could not tell.
  it('stays quiet for a gap that is small against the trip’s own pace', () => {
    expect(shouldPromptReplan({ behindKm: 60, behindDays: 0.15 })).toBe(false)
  })

  it('prompts when the gap is large by both measures', () => {
    expect(shouldPromptReplan({ behindKm: 180, behindDays: 0.9 })).toBe(true)
  })

  // The final night has no remaining pace to measure against, and silence
  // there would be worse than an absolute answer.
  it('falls back to distance alone when there is no pace left', () => {
    expect(shouldPromptReplan({ behindKm: 180, behindDays: null })).toBe(true)
    expect(shouldPromptReplan({ behindKm: 10, behindDays: null })).toBe(false)
  })

  it('never prompts a traveler who is ahead', () => {
    expect(shouldPromptReplan({ behindKm: -120, behindDays: -0.8 })).toBe(false)
  })

  it('says nothing when there is no plan to compare against', () => {
    expect(shouldPromptReplan(null)).toBe(false)
  })
})

describe('describePlanDrift', () => {
  it('leads with days, and keeps the kilometres as evidence', () => {
    const said = describePlanDrift({ behindKm: 180, behindDays: 1.0 })
    expect(said).toContain('about a day behind')
    expect(said).toContain('180 km')
  })

  it('reads naturally at half a day and at several', () => {
    expect(describePlanDrift({ behindKm: 60, behindDays: 0.5 })).toContain(
      'half a day',
    )
    expect(describePlanDrift({ behindKm: 400, behindDays: 2.4 })).toContain(
      'about 2 days behind',
    )
  })

  it('falls back to distance when days cannot be worked out', () => {
    expect(describePlanDrift({ behindKm: 90, behindDays: null })).toBe(
      "You're 90 km short of tonight's stop.",
    )
  })
})
