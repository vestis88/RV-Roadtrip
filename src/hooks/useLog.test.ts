import { describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

type Snap = { docs: { id: string; data: () => unknown }[] }
let emit: (snap: Snap) => void = () => {}

vi.mock('firebase/firestore', () => ({
  collection: (_db: unknown, ...path: string[]) => ({ path: path.join('/') }),
  query: (ref: unknown) => ref,
  orderBy: (field: string) => field,
  onSnapshot: (_q: unknown, next: (snap: Snap) => void) => {
    emit = next
    return () => {}
  },
}))
vi.mock('../lib/firebase', () => ({ db: {} }))

const { useLog } = await import('./useLog')

function entry(id: string, date: string, createdAt: string) {
  return {
    id,
    data: () => ({
      date,
      createdAt,
      refType: 'stop',
      refPath: `trips/t/corridorStops/${id}`,
    }),
  }
}

/**
 * Requested 2026-08-24: "Dairy should be chronologically ordered."
 *
 * The query orders by `createdAt` — when the entry was written down — which
 * stopped being the same thing as chronological the moment happened-at
 * became editable earlier the same day.
 */
describe('diary ordering', () => {
  it('orders by the day it happened, not the day it was typed', async () => {
    const { result } = renderHook(() => useLog('trip1'))
    // As the query returns them: by createdAt. The backdated entry was
    // written down last and belongs first.
    emit({
      docs: [
        entry('a', '2026-07-14', '2026-07-14T18:00:00.000Z'),
        entry('b', '2026-07-11', '2026-07-15T09:00:00.000Z'),
      ],
    })
    await waitFor(() =>
      expect(result.current.entries.map((e) => e.id)).toEqual(['b', 'a']),
    )
  })

  // `date` is a calendar day with no time in it, so two things done on the
  // same day can only be ordered by when they were written down.
  it('falls back to when it was typed within a single day', async () => {
    const { result } = renderHook(() => useLog('trip1'))
    emit({
      docs: [
        entry('late', '2026-07-11', '2026-07-11T20:00:00.000Z'),
        entry('early', '2026-07-11', '2026-07-11T08:00:00.000Z'),
      ],
    })
    await waitFor(() =>
      expect(result.current.entries.map((e) => e.id)).toEqual(['early', 'late']),
    )
  })

  // Oldest first: a diary reads forwards.
  it('reads forwards', async () => {
    const { result } = renderHook(() => useLog('trip1'))
    emit({
      docs: [
        entry('c', '2026-07-12', '2026-07-12T10:00:00.000Z'),
        entry('a', '2026-07-10', '2026-07-10T10:00:00.000Z'),
        entry('b', '2026-07-11', '2026-07-11T10:00:00.000Z'),
      ],
    })
    await waitFor(() =>
      expect(result.current.entries.map((e) => e.id)).toEqual(['a', 'b', 'c']),
    )
  })
})
