import { stayCostOf, type CorridorStop } from '@rv/shared'

/**
 * What the locked stops actually cost, in the unit the traveler curates in.
 *
 * Requested 2026-08-23: "I want to be able to state how long we intend to
 * stay at that activity/stop. This will yield a total duration that we can
 * then simply curate ourselves by locking/unlocking stops."
 *
 * WHY THIS PACKS INSTEAD OF SUMMING, which is the whole design.
 *
 * `sum(stay) + sum(drive)` is not a trip length, and presenting it as one
 * would have made the headline number useless. You cannot do a full-day
 * sight AND a six-hour drive on the same day — that is exactly why
 * `maxDriveHoursPerDay` exists as a setting. "84 h 20 min" is unactionable;
 * a traveler cannot tell whether it fits in a fortnight. "~11 days, you have
 * 14" is the number they curate against, so that is the number this
 * produces.
 *
 * The packing is deliberately simple — greedy, in route order, one day at a
 * time — rather than the full pacing algorithm the generator uses. This is
 * an estimate shown live while the traveler locks and unlocks stops; it must
 * be instant, pure and obvious enough to be trusted. The real plan is still
 * built by the day pipeline. Same reasoning as planDrift's straight-line
 * distances: this decides what to TELL someone, not what to do.
 */

/** Hours of a day that can go on driving and sights before it stops being a holiday. */
const USABLE_HOURS_PER_DAY = 10

export interface BudgetStop {
  stayDuration?: CorridorStop['stayDuration']
  timeNeeded?: CorridorStop['timeNeeded']
  /** Done stops are behind you — see doneAt. Excluded from what is left. */
  doneAt?: string
}

export interface TripBudget {
  /** Real driving minutes across the legs supplied, or 0 when none are. */
  driveMinutes: number
  /** Daylight hours the stops themselves ask for. */
  stayHours: number
  /** Nights parked at a basecamp stop, which cost days without driving. */
  nightsAtStops: number
  /** Days the stops and drives need, packed rather than summed. */
  daysNeeded: number
  /** Days between the trip's start and end dates, inclusive. */
  daysAvailable: number
  /** Positive = room to add more. Negative = over. */
  spareDays: number
}

/**
 * `legs[i]` is the drive INTO `stops[i]` where available. Callers that have
 * no real legs yet pass none and get a stop-time-only estimate rather than
 * nothing — the number appears the moment the first stop is locked, before
 * Google has answered.
 */
export function tripBudget(input: {
  stops: BudgetStop[]
  legs?: { durationMin: number }[]
  startDate: string
  endDate: string
  maxDriveHoursPerDay: number
}): TripBudget {
  const { legs = [], startDate, endDate, maxDriveHoursPerDay } = input
  // What is LEFT, not what was planned. A stop already visited stops
  // costing days, which is what makes this number useful on the road.
  const stops = input.stops.filter((stop) => !stop.doneAt)

  const driveMinutes = legs.reduce((sum, leg) => sum + leg.durationMin, 0)
  let stayHours = 0
  let nightsAtStops = 0
  for (const stop of stops) {
    const cost = stayCostOf(stop)
    stayHours += cost.hours
    nightsAtStops += cost.nights
  }

  const daysAvailable = daysBetweenInclusive(startDate, endDate)
  const daysNeeded = packIntoDays({
    stayHours,
    driveHours: driveMinutes / 60,
    nightsAtStops,
    maxDriveHoursPerDay,
  })

  return {
    driveMinutes,
    stayHours,
    nightsAtStops,
    daysNeeded,
    daysAvailable,
    spareDays: daysAvailable - daysNeeded,
  }
}

/**
 * Days needed for a given amount of driving and sightseeing.
 *
 * Two ceilings, and the answer is whichever binds:
 *
 *  - **Driving.** The traveler's own `maxDriveHoursPerDay`. This is the one
 *    that usually decides a long trip, and ignoring it is what would make a
 *    naive sum lie the most.
 *  - **Daylight.** Drives and sights compete for the same hours, so the
 *    combined total is spread across days at USABLE_HOURS_PER_DAY. A day of
 *    two short drives and a full-day castle is a full day even though the
 *    driving alone would have fitted easily.
 *
 * Basecamp nights are added rather than packed: three nights at a lake is
 * three days whatever else is happening, and nothing else can be scheduled
 * into them.
 *
 * Rounded UP, and floored at one day for any trip with anything in it at
 * all: half a day of driving still consumes a day of the calendar.
 */
function packIntoDays(input: {
  stayHours: number
  driveHours: number
  nightsAtStops: number
  maxDriveHoursPerDay: number
}): number {
  const { stayHours, driveHours, nightsAtStops, maxDriveHoursPerDay } = input
  if (stayHours <= 0 && driveHours <= 0 && nightsAtStops <= 0) return 0

  const byDriving =
    maxDriveHoursPerDay > 0 ? driveHours / maxDriveHoursPerDay : 0
  const byDaylight = (stayHours + driveHours) / USABLE_HOURS_PER_DAY
  const moving = Math.ceil(Math.max(byDriving, byDaylight))

  return Math.max(1, moving + nightsAtStops)
}

/** Inclusive, so a trip that starts and ends on the same date is one day. */
function daysBetweenInclusive(startDate: string, endDate: string): number {
  const start = new Date(`${startDate}T00:00:00Z`).getTime()
  const end = new Date(`${endDate}T00:00:00Z`).getTime()
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0
  return Math.max(0, Math.round((end - start) / 86_400_000) + 1)
}

/**
 * The one-line summary the board's header carries.
 *
 * Leads with what the traveler chose (stops), then what it costs (days),
 * then the only number that prompts an action — how much room is left. The
 * over case is stated as a shortfall rather than a negative, because "3 days
 * over" is something you can act on and "-3 days spare" is arithmetic.
 */
export function describeBudget(budget: TripBudget, stopCount: number): string {
  const stops = `${stopCount} stop${stopCount === 1 ? '' : 's'}`
  const needed = `~${budget.daysNeeded} day${budget.daysNeeded === 1 ? '' : 's'}`
  if (budget.daysAvailable <= 0) return `${stops} · ${needed}`
  if (budget.spareDays < 0) {
    const over = Math.abs(budget.spareDays)
    return `${stops} · ${needed} · ${over} day${over === 1 ? '' : 's'} over`
  }
  return `${stops} · ${needed} · ${budget.spareDays} spare`
}
