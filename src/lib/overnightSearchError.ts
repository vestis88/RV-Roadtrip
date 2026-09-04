import { isDeadlineExceeded, serverAuthoredMessage } from './callableError'

/**
 * What to tell the traveler when looking for somewhere to sleep went wrong.
 *
 * The "Where to sleep" row shipped saying "Could not look for places to
 * sleep — please try again." for every failure, and a screenshot on
 * 2026-09-03 showed exactly why that is not enough: the row had failed twice
 * over — once in the empty slot and once in the footer — and neither line
 * said anything the traveler could act on. The commonest cause this week is
 * the Claude account being out of credit, which no amount of pressing the
 * button again will fix. getOvernightCandidates now names its cause, and
 * this prefers that account over the generic line, the same way the explore
 * search (2026-08-12) and the country briefs (2026-08-18) do.
 */
export const GENERIC_OVERNIGHT_SEARCH_ERROR =
  'Could not look for places to sleep — please try again.'

/**
 * The lookup runs Places, Overpass and Claude together and then, when OSM
 * finds nothing, a second Claude call — all against the callable's 180s
 * ceiling. Re-pressing runs the same race again, so the honest thing to say
 * is that it is still going rather than to advise a retry.
 */
const OVERNIGHT_SEARCH_TIMEOUT_MESSAGE =
  'That search took too long to finish on this phone. It is still running on ' +
  'the server — anything it finds appears here on its own.'

export function describeOvernightSearchError(error: unknown): string {
  if (isDeadlineExceeded(error)) return OVERNIGHT_SEARCH_TIMEOUT_MESSAGE
  return serverAuthoredMessage(error) ?? GENERIC_OVERNIGHT_SEARCH_ERROR
}
