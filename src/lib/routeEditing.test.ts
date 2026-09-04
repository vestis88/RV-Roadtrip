import { describe, expect, it } from 'vitest'
import type { CorridorStopWithId } from '../hooks/useCorridorStops'
import { canEditRoute, stopsAddableToRoute } from './routeEditing'

function stop(over: Partial<CorridorStopWithId>): CorridorStopWithId {
  return {
    id: 's',
    name: 'Somewhere',
    lat: 46,
    lng: 12,
    status: 'locked',
    linkedDayIds: [],
    ...over,
  } as unknown as CorridorStopWithId
}

/**
 * The gate used to ask the frozen-plan question — "are there committed stops
 * from a generation?" — while the panel it opens lists the kept stops in
 * driving order. On a curated trip that is nothing versus a full list, and
 * the button disappeared once the skeleton writer had linked days to every
 * kept stop.
 */
describe('canEditRoute', () => {
  it('offers the panel whenever there is an order to arrange', () => {
    expect(canEditRoute([{ id: 'a' }, { id: 'b' }])).toBe(true)
  })

  it('stays hidden when there is nothing to reorder', () => {
    expect(canEditRoute([{ id: 'a' }])).toBe(false)
    expect(canEditRoute([])).toBe(false)
  })
})

describe('stopsAddableToRoute', () => {
  it('is the kept stops with no day yet, minus the ones behind you', () => {
    expect(
      stopsAddableToRoute([
        stop({ id: 'pinned' }),
        stop({ id: 'placed', linkedDayIds: ['d1'] }),
        stop({ id: 'been-there', doneAt: '2026-09-01T10:00:00.000Z' }),
        stop({ id: 'suggestion', status: 'proposed' }),
      ]),
    ).toEqual([{ id: 'pinned', name: 'Somewhere' }])
  })
})
