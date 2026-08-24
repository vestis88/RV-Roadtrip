import { describe, expect, it } from 'vitest'
import { planDayCleanup, staleDays } from './dayCleanup'
import type { CorridorStopWithId } from '../hooks/useCorridorStops'
import type { TripDayWithId } from '../hooks/useTripDays'

function stop(
  id: string,
  status: CorridorStopWithId['status'],
  linkedDayIds: string[] = [],
): CorridorStopWithId {
  return {
    id,
    name: id,
    lat: 47,
    lng: 11,
    country: 'DE',
    status,
    linkedDayIds,
    priority: 'must-see',
    rank: 0,
  } as unknown as CorridorStopWithId
}

function day(
  id: string,
  index: number,
  overnight = 'Somewhere',
  type: TripDayWithId['type'] = 'drive',
): TripDayWithId {
  return {
    id,
    index,
    date: `2026-08-${String(20 + index).padStart(2, '0')}`,
    type,
    overnight: { name: overnight, lat: 47, lng: 11, country: 'DE' },
    summary: '',
  } as unknown as TripDayWithId
}

describe('finding days left behind by a removed stop', () => {
  it('flags a day whose only owner was rejected', () => {
    const stale = staleDays(
      [stop('a', 'rejected', ['d1']), stop('b', 'locked', ['d2'])],
      [day('d1', 0), day('d2', 1)],
    )
    expect(stale.map((d) => d.id)).toEqual(['d1'])
  })

  it('flags a day whose owner was merely unlocked', () => {
    // Unlock writes `candidate`, which is out of the route just as surely as
    // a rejection — that is the whole point of the button.
    const stale = staleDays([stop('a', 'candidate', ['d1'])], [day('d1', 0)])
    expect(stale.map((d) => d.id)).toEqual(['d1'])
  })

  /**
   * The direction of this check is load-bearing, and getting it backwards
   * would delete the itinerary of every trip that never ran a full
   * generation. Skeleton days (writeSkeletonDays) are claimed by NOBODY —
   * no stop records them — so "days nothing links to" is exactly the wrong
   * rule and this is the test that says so.
   */
  it('leaves skeleton days alone, which no stop claims at all', () => {
    const stale = staleDays(
      [stop('a', 'locked'), stop('b', 'locked')],
      [day('d1', 0), day('d2', 1), day('d3', 2)],
    )
    expect(stale).toEqual([])
  })

  it('keeps a day that any live stop still claims', () => {
    // A day two stops share survives one of them leaving.
    const stale = staleDays(
      [stop('a', 'rejected', ['d1']), stop('b', 'committed', ['d1'])],
      [day('d1', 0)],
    )
    expect(stale).toEqual([])
  })
})

describe('planning what a removal does to the rest of the trip', () => {
  const days = [day('d1', 0), day('d2', 1), day('d3', 2), day('d4', 3)]

  it('closes the gap rather than leaving a hole in the dates', () => {
    const plan = planDayCleanup({
      removeDayIds: ['d2'],
      days,
      stops: [stop('a', 'rejected', ['d2'])],
      startDate: '2026-08-20',
    })
    expect(plan.renumber).toEqual([
      { id: 'd3', index: 1, date: '2026-08-21' },
      { id: 'd4', index: 2, date: '2026-08-22' },
    ])
  })

  it('leaves untouched days out of the write entirely', () => {
    const plan = planDayCleanup({
      removeDayIds: ['d4'],
      days,
      stops: [stop('a', 'rejected', ['d4'])],
      startDate: '2026-08-20',
    })
    // Removing the last day moves nothing, so nothing is rewritten.
    expect(plan.renumber).toEqual([])
  })

  /**
   * `validatePacing` still throws on a rest day that is not at the previous
   * night's overnight, and it is the one invariant left in that function.
   * Deleting the day in front of a rest day breaks it, so the rest day has
   * to stop being one.
   */
  it('demotes a rest day whose predecessor was just deleted', () => {
    const plan = planDayCleanup({
      removeDayIds: ['d2'],
      days: [
        day('d1', 0, 'Munich'),
        day('d2', 1, 'Füssen'),
        day('d3', 2, 'Füssen', 'rest'),
      ],
      stops: [stop('a', 'rejected', ['d2'])],
      startDate: '2026-08-20',
    })
    expect(plan.demoteToDrive).toEqual(['d3'])
  })

  it('leaves a rest day alone when its basecamp survives', () => {
    const plan = planDayCleanup({
      removeDayIds: ['d1'],
      days: [
        day('d1', 0, 'Munich'),
        day('d2', 1, 'Füssen'),
        day('d3', 2, 'Füssen', 'rest'),
      ],
      stops: [stop('a', 'rejected', ['d1'])],
      startDate: '2026-08-20',
    })
    expect(plan.demoteToDrive).toEqual([])
  })

  /**
   * The stale link is the thing that makes reconcileCorridor throw
   * ("the committed stops' linked days do not cover every day in the trip"),
   * so clearing it is not tidiness — it is what keeps "Edit route" usable.
   */
  it('names the stops whose linkedDayIds still point at the removed days', () => {
    const plan = planDayCleanup({
      removeDayIds: ['d2', 'd3'],
      days,
      stops: [
        stop('a', 'rejected', ['d2']),
        stop('b', 'committed', ['d3', 'd4']),
        stop('c', 'locked', ['d1']),
      ],
      startDate: '2026-08-20',
    })
    expect(plan.unlinkStopIds.sort()).toEqual(['a', 'b'])
  })

  it('does nothing at all when there is nothing to remove', () => {
    const plan = planDayCleanup({
      removeDayIds: [],
      days,
      stops: [],
      startDate: '2026-08-20',
    })
    expect(plan).toEqual({
      removeDayIds: [],
      renumber: [],
      demoteToDrive: [],
      unlinkStopIds: [],
    })
  })

  // No start date means no date to count from, and guessing one would
  // rewrite every day in the trip to a fiction.
  it('refuses to renumber without a start date', () => {
    const plan = planDayCleanup({
      removeDayIds: ['d2'],
      days,
      stops: [],
      startDate: '',
    })
    expect(plan.removeDayIds).toEqual([])
  })
})
