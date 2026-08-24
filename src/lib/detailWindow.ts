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
 * What the slider is called.
 *
 * It was "Plan ahead", and that was wrong in a way that cost a traveler an
 * evening: set to 2 on a six-day trip it produced a full six-day route, and
 * the obvious reading of the label is that it should have produced two days
 * of trip. It never controlled that. The route is whole-trip by necessity —
 * a trip has a fixed finish on a fixed date, so where you sleep on night one
 * is decided by how far there is left to go and how many days remain, and
 * two days of route have nothing to compute that from. What the slider
 * controls is the part that genuinely is per-day and genuinely is expensive:
 * each day's activities and restaurants. So the label says that instead.
 */
export const DETAIL_WINDOW_LABEL = 'Activities & food filled in'

/**
 * What that setting actually buys, in the traveler's terms.
 *
 * Leads with the whole-trip fact rather than mentioning it second. The old
 * wording opened with "The first N days are filled in up front", which is
 * the sentence that reads as "and the rest are not planned" — the very
 * misreading this has to prevent.
 */
export function describeDetailWindow(days: number): string {
  const opening =
    'Your whole trip is always routed — every night’s town and every drive,' +
    ' start to finish. This is only how far ahead each day’s activities and' +
    ' restaurants are worked out: '
  const window =
    days === 1
      ? 'today only.'
      : `the next ${days} days.`
  const rest = ' The rest fill in when you open them, a few seconds each.'
  const cost =
    days > CHATTY_ABOVE_DAYS
      ? ` Generating a plan takes longer at ${days} days, and re-planning` +
        ' redoes all of them.'
      : ''
  return `${opening}${window}${rest}${cost}`
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
export const NON_INVALIDATING_SETTINGS = new Set<string>([
  'detailWindowDays',
  // Interests, added 2026-08-19 at the traveler's request, and for a
  // different reason from the window above.
  //
  // An interest is not a constraint the existing days were built against —
  // it is a preference for what to LOOK FOR next. Adding "hot springs"
  // does not make yesterday's route wrong; it makes the next rescan, the
  // next "Find more stops", and any re-plan the traveler chooses to run
  // search for hot springs. Flagging the whole plan stale for it puts
  // "Re-plan trip" in front of someone who ticked a box, and asks them to
  // pay for a full regeneration to express an interest. Notes already
  // behave this way — NotesScreen writes them without going through here at
  // all — so this also makes the two halves of "what should we look for"
  // agree with each other.
  'interests',
  /**
   * Everything below joins them on 2026-08-23, on the same reasoning taken
   * further: "I don't like that it goes 'stale' and needs full generation.
   * It should just grow organically."
   *
   * Worth knowing what `stale` actually does before deciding how much can
   * leave it, because it is far less than the name suggests. It has exactly
   * two effects — the Trip-setup button reads "Rebuild plan" instead of
   * "Generate full plan", and dateShift.ts gates its shortcut on it.
   * NOTHING blocks. A stale plan renders, opens, shares and drives exactly
   * like a ready one. So "stale" was never a broken plan; it was an offer to
   * pay for a new one.
   *
   * Each of these changes what the app should do NEXT, not whether the days
   * already written are wrong:
   *
   * - maxDriveHoursPerDay and restDayFrequency are pacing preferences, and
   *   pacing is advice now (see pacingValidator's driveLengthWarnings). The
   *   existing days get measured against the new number and say so; they do
   *   not become invalid because the traveler moved a slider.
   * - preferredCountries and interests steer what the next search looks for.
   * - travelers and vehicle change what is SUITABLE — which overnight fits,
   *   which activity suits the ages — and so apply to what is chosen from
   *   here on. Re-deciding sixty already-chosen days is not what someone
   *   adding a passenger asked for.
   * - offGridTolerance is the same shape: it filters overnight options at
   *   the moment they are offered.
   *
   * What is NOT here, deliberately: startDate and endDate. Those change the
   * dates the days carry, and they already have the cheap answer — the
   * "Move the plan N days later" shortcut, which is gated on them.
   */
  'maxDriveHoursPerDay',
  'restDayFrequency',
  'preferredCountries',
  'travelers',
  'vehicle',
  'offGridTolerance',
  /**
   * The trip's endpoints, added once days derived from the board
   * (2026-08-23, phase 4).
   *
   * These were the last settings with no incremental answer: moving the
   * start point changed the route the days were threaded along, and only a
   * regeneration could re-thread it. That is no longer true. The board's
   * route is rebuilt from the endpoints on the spot, and the day skeleton
   * follows it — see skeletonDays — so a moved endpoint re-dates and
   * re-routes the itinerary without asking anyone to pay for anything.
   */
  'startPoint',
  'endPoint',
])

export { DEFAULT_DETAIL_WINDOW_DAYS }
