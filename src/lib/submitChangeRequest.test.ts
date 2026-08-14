import { describe, expect, it, vi } from 'vitest'
import type { Trip } from '@rv/shared'

vi.mock('firebase/firestore', () => ({
  addDoc: vi.fn(),
  collection: () => ({}),
  serverTimestamp: () => 'ts',
}))
vi.mock('./firebase', () => ({ db: {} }))

const { replanFromDate } = await import('./submitChangeRequest')

function tripStarting(startDate: string): Trip {
  return {
    settings: { startDate },
  } as unknown as Trip
}

describe('replanFromDate', () => {
  // The 2026-08-13 corruption. runReplan plans the remainder as a trip that
  // STARTS on this date, so handing it today's date for a trip that leaves
  // tomorrow made the calendar gap into travelling days: a three-night trip
  // came back longer than it was, with days dated before its own departure
  // and a route back out through towns the preserved days already covered.
  it('replans a not-yet-started trip from its departure date, not from today', () => {
    expect(replanFromDate(tripStarting('2026-08-14'), '2026-08-13')).toBe(
      '2026-08-14',
    )
  })

  it('replans a trip already under way from today', () => {
    expect(replanFromDate(tripStarting('2026-08-10'), '2026-08-13')).toBe(
      '2026-08-13',
    )
  })

  it('treats the departure day itself as today', () => {
    expect(replanFromDate(tripStarting('2026-08-13'), '2026-08-13')).toBe(
      '2026-08-13',
    )
  })
})
