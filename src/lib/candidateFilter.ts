import type { CorridorStopWithId } from '../hooks/useCorridorStops'
import { candidatePriority } from './exploreCandidateActions'

/**
 * Which stops the list below the map is showing.
 *
 * Requested 2026-08-25: "There should be a filter for the list below the
 * map. Selecting only locked in, only must see, only not locked in or all.
 * Add more if that makes sense."
 *
 * Two additions did make sense, and both replace something rather than
 * piling on:
 *
 *  - **`done`** folds in the "Show done (N)" toggle added two days earlier.
 *    Done stops leave the planning list by request, and a second, differently
 *    shaped control for getting them back was one mechanism too many — a
 *    bucket in the filter says the same thing and reads as part of the set.
 *  - **`no-day`** answers the other half of the same message: "the day view.
 *    I don't know how to get to that view for the locked in days." A locked
 *    stop with no day is exactly the stop that has no way into Day View, and
 *    until now nothing on the board could show you which ones those were.
 *
 * `all` means everything still ahead of you. Done stops are excluded from it
 * deliberately — the list is a to-do on the road, which is why they were
 * taken out of it in the first place — and `done` is where they live.
 */
export type CandidateFilter =
  | 'all'
  | 'locked'
  | 'unlocked'
  | 'must-see'
  | 'no-day'
  | 'done'

export const CANDIDATE_FILTER_LABEL: Record<CandidateFilter, string> = {
  all: 'All',
  locked: 'Locked in',
  unlocked: 'Not locked',
  'must-see': 'Must see',
  'no-day': 'No day yet',
  done: 'Done',
}

/** Order shown, most-used first. */
export const CANDIDATE_FILTER_ORDER: CandidateFilter[] = [
  'all',
  'locked',
  'unlocked',
  'must-see',
  'no-day',
  'done',
]

function matches(stop: CorridorStopWithId, filter: CandidateFilter): boolean {
  const done = !!stop.doneAt
  switch (filter) {
    case 'done':
      return done
    case 'locked':
      return !done && stop.status === 'locked'
    case 'unlocked':
      return !done && stop.status !== 'locked'
    case 'must-see':
      return !done && candidatePriority(stop) === 'must-see'
    // A stop that is IN the route but has no day is the one with no way into
    // Day View. An unlocked candidate has no day either, and saying so about
    // every one of them would make this bucket useless.
    case 'no-day':
      return (
        !done &&
        stop.status === 'locked' &&
        (stop.linkedDayIds ?? []).length === 0
      )
    case 'all':
      return !done
  }
}

export function filterCandidates(
  stops: CorridorStopWithId[],
  filter: CandidateFilter,
): CorridorStopWithId[] {
  return stops.filter((stop) => matches(stop, filter))
}

/**
 * How many stops each bucket holds, for the chips.
 *
 * Computed from the same predicate the filtering uses rather than counted
 * separately — a chip promising seven and a list showing five is the kind of
 * disagreement the header and the itinerary already taught this codebase
 * about.
 */
export function countByFilter(
  stops: CorridorStopWithId[],
): Record<CandidateFilter, number> {
  const counts = {} as Record<CandidateFilter, number>
  for (const filter of CANDIDATE_FILTER_ORDER) {
    counts[filter] = stops.filter((stop) => matches(stop, filter)).length
  }
  return counts
}
