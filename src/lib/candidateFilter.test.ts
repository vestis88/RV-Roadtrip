import { describe, expect, it } from 'vitest'
import {
  CANDIDATE_FILTER_ORDER,
  countByFilter,
  filterCandidates,
} from './candidateFilter'
import type { CorridorStopWithId } from '../hooks/useCorridorStops'

function stop(
  id: string,
  over: Partial<CorridorStopWithId> = {},
): CorridorStopWithId {
  return {
    id,
    name: id,
    lat: 47,
    lng: 11,
    country: 'DE',
    status: 'candidate',
    linkedDayIds: [],
    priority: 'worth-a-detour',
    ...over,
  } as CorridorStopWithId
}

const STOPS = [
  stop('lockedWithDay', { status: 'locked', linkedDayIds: ['d1'] }),
  stop('lockedNoDay', { status: 'locked' }),
  stop('candidateMustSee', { priority: 'must-see' }),
  stop('plainCandidate'),
  stop('doneOne', {
    status: 'locked',
    doneAt: '2026-08-20T10:00:00.000Z',
    priority: 'must-see',
  }),
]

/** Requested 2026-08-25: "There should be a filter for the list below the map." */
describe('filtering the candidate list', () => {
  it('shows everything still ahead of you by default', () => {
    const ids = filterCandidates(STOPS, 'all').map((s) => s.id)
    // Done is excluded on purpose: the list is a to-do on the road, which is
    // why done stops were taken out of it in the first place.
    expect(ids).toEqual([
      'lockedWithDay',
      'lockedNoDay',
      'candidateMustSee',
      'plainCandidate',
    ])
  })

  it('shows only what is in the route', () => {
    expect(filterCandidates(STOPS, 'locked').map((s) => s.id)).toEqual([
      'lockedWithDay',
      'lockedNoDay',
    ])
  })

  it('shows only what is not in the route', () => {
    expect(filterCandidates(STOPS, 'unlocked').map((s) => s.id)).toEqual([
      'candidateMustSee',
      'plainCandidate',
    ])
  })

  it('shows only the top interest level', () => {
    expect(filterCandidates(STOPS, 'must-see').map((s) => s.id)).toEqual([
      'candidateMustSee',
    ])
  })

  /**
   * The other half of the same report: "I don't know how to get to that view
   * for the locked in days." A locked stop with no day is exactly the stop
   * with no way into Day View, and nothing on the board could show you which
   * ones those were.
   */
  it('shows kept stops that have no day yet', () => {
    expect(filterCandidates(STOPS, 'no-day').map((s) => s.id)).toEqual([
      'lockedNoDay',
    ])
  })

  // An unlocked candidate has no day either, and saying so about every one
  // of them would make the bucket useless.
  it('does not call every unlocked candidate a stop without a day', () => {
    const ids = filterCandidates(STOPS, 'no-day').map((s) => s.id)
    expect(ids).not.toContain('plainCandidate')
    expect(ids).not.toContain('candidateMustSee')
  })

  it('shows done stops only in their own bucket', () => {
    expect(filterCandidates(STOPS, 'done').map((s) => s.id)).toEqual(['doneOne'])
    for (const filter of CANDIDATE_FILTER_ORDER.filter((f) => f !== 'done')) {
      expect(filterCandidates(STOPS, filter).map((s) => s.id)).not.toContain(
        'doneOne',
      )
    }
  })

  /**
   * Counted with the same predicate the filtering uses. A chip promising
   * seven above a list showing five is the disagreement the header and the
   * itinerary already taught this codebase about.
   */
  it('counts each bucket as exactly what that bucket shows', () => {
    const counts = countByFilter(STOPS)
    for (const filter of CANDIDATE_FILTER_ORDER) {
      expect(counts[filter], filter).toBe(filterCandidates(STOPS, filter).length)
    }
  })
})

/**
 * Reported 2026-08-26: the out-of-step banner promised to fix thirteen kept
 * stops while the rebuild panel beneath it said six. `stopsAddableToRoute`
 * counted stops already marked done — which need no day and cannot be added
 * to a route, being behind you.
 */
describe('which kept stops still need a day', () => {
  it('leaves out the ones already done', async () => {
    const { stopsAddableToRoute } = await import('./routeEditing')
    const addable = stopsAddableToRoute([
      stop('ahead', { status: 'locked' }),
      stop('behindUs', {
        status: 'locked',
        doneAt: '2026-08-24T10:00:00.000Z',
      }),
    ])
    expect(addable.map((s) => s.id)).toEqual(['ahead'])
  })

  // And it still finds the ones that genuinely have no day.
  it('finds a kept stop with no day', async () => {
    const { stopsAddableToRoute } = await import('./routeEditing')
    expect(
      stopsAddableToRoute([
        stop('withDay', { status: 'locked', linkedDayIds: ['d1'] }),
        stop('withoutDay', { status: 'locked' }),
      ]).map((s) => s.id),
    ).toEqual(['withoutDay'])
  })
})
