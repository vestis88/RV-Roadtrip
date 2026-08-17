import { DEFAULT_DETAIL_WINDOW_DAYS } from '@rv/shared'

/**
 * Past this the window is worth warning about rather than just describing.
 *
 * Not a limit — MAX_DETAIL_WINDOW_DAYS is the limit, and a traveler who
 * wants two weeks laid out can have two weeks. This is only the point where
 * the trade stops being free: every day in the window is a day the plan
 * waits for at generation, and a day a replan pays for again.
 */
const CHATTY_ABOVE_DAYS = 7

/**
 * What "Plan ahead: N days" actually buys, in the traveler's terms.
 *
 * The slider sets how far ahead activities and restaurants are worked out —
 * NOT how much of the trip is planned, which is always all of it. That
 * distinction is the whole reason this sentence exists: "plan ahead 3 days"
 * on a three-week trip reads like the other eighteen days are missing, and
 * they are not. The route, the overnight towns and the driving are settled
 * end to end either way.
 */
export function describeDetailWindow(days: number): string {
  const opening =
    days === 1
      ? 'Only the first day is filled in up front'
      : `The first ${days} days are filled in up front`
  const rest =
    ' — the route and overnight stops are planned for the whole trip either' +
    ' way. Later days fill in when you open them, a few seconds each.'
  const cost =
    days > CHATTY_ABOVE_DAYS
      ? ` Generating a plan takes longer at ${days} days, and re-planning` +
        ' redoes all of them.'
      : ''
  return `${opening}${rest}${cost}`
}

/**
 * Settings that do NOT invalidate a finished plan.
 *
 * Every other setting edit marks a `ready` trip `stale`, which is right: a
 * new finish point or a lower drive-hours ceiling means the days that exist
 * were worked out against something that is no longer true. The detail
 * window is not like that. It changes how far ahead days are filled in — the
 * lazy path applies the new number the moment it is written, and the eager
 * one applies it at the next generation. Marking the trip stale for it would
 * put "Re-plan trip" in front of a traveler who moved a slider, asking them
 * to pay for a full regeneration to get something they already have.
 */
export const NON_INVALIDATING_SETTINGS = new Set<string>(['detailWindowDays'])

export { DEFAULT_DETAIL_WINDOW_DAYS }
