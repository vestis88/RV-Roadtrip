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

/**
 * One day of the packed itinerary.
 *
 * Generic in the stop so a caller that needs the whole corridor stop — the
 * skeleton writer needs its name, coordinates and country — gets it back
 * rather than the duration fields this file happens to read.
 */
export interface PackedDay<T extends BudgetStop = BudgetStop> {
  /** Stops reached on this day, in route order. Empty on a pure driving day. */
  stops: T[]
  /** Real driving minutes done on this day. */
  driveMinutes: number
  /** Daylight the stops on this day ask for. */
  stayMinutes: number
  /**
   * Parked at the stop rather than travelling to it — the second and later
   * nights of a basecamp. Maps to a `rest` day when this is written out.
   */
  parkedAt?: T
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
  // The COUNT comes from the same function that does the assignment. Two
  // implementations would drift, and the traveler would read "~11 days" in
  // the header above an itinerary of nine.
  const daysNeeded = packStopsIntoDays({
    stops,
    legs,
    maxDriveHoursPerDay,
  }).length

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
 * The stops laid out day by day.
 *
 * Two ceilings decide when a day is full, and whichever binds wins:
 *
 *  - **Driving.** The traveler's own `maxDriveHoursPerDay`. A leg longer
 *    than that becomes several days on its own — two stops 1,500 km apart is
 *    four days, not two, and "one day per stop" would have quietly lost that.
 *  - **Daylight.** Drives and sights compete for the same hours, so their
 *    sum is capped at USABLE_HOURS_PER_DAY. A day of two short drives and a
 *    full-day castle is a full day even though the driving alone would fit.
 *
 * A basecamp stop takes its own days: `nights: 3` means three nights slept
 * there, so three days, with the drive that got you there riding on the
 * first. It never shares a day with another stop — the point of saying
 * "three nights at the lake" is that the lake is what those days are for.
 *
 * `legs[i]` is the drive INTO `stops[i]`, and `legs[stops.length]` is the
 * run to the trip's end point, which still costs a day even though no stop
 * sits on it.
 */
export function packStopsIntoDays<T extends BudgetStop>(input: {
  stops: T[]
  legs?: { durationMin: number }[]
  maxDriveHoursPerDay: number
}): PackedDay<T>[] {
  const { stops, legs = [], maxDriveHoursPerDay } = input
  const maxDriveMin = Math.max(1, maxDriveHoursPerDay) * 60
  const usableMin = USABLE_HOURS_PER_DAY * 60

  const days: PackedDay<T>[] = []
  let current = emptyDay<T>()

  const closeIfUsed = () => {
    if (current.stops.length > 0 || current.driveMinutes > 0) {
      days.push(current)
      current = emptyDay<T>()
    }
  }

  /** Splits a drive too long for one day, returning what is left of it. */
  const spendLongDrive = (minutes: number): number => {
    let remaining = minutes
    while (remaining > maxDriveMin) {
      const room = maxDriveMin - current.driveMinutes
      current.driveMinutes += room
      days.push(current)
      current = emptyDay<T>()
      remaining -= room
    }
    return remaining
  }

  stops.forEach((stop, index) => {
    const legMinutes = legs[index]?.durationMin ?? 0
    const cost = stayCostOf(stop)
    const remaining = spendLongDrive(legMinutes)

    if (cost.nights > 0) {
      // Its own block of days, arrival drive on the first.
      closeIfUsed()
      for (let night = 0; night < cost.nights; night++) {
        days.push({
          stops: night === 0 ? [stop] : [],
          driveMinutes: night === 0 ? remaining : 0,
          stayMinutes: 0,
          ...(night === 0 ? {} : { parkedAt: stop }),
        })
      }
      return
    }

    const stayMinutes = cost.hours * 60
    const overDrive = current.driveMinutes + remaining > maxDriveMin
    const overDaylight =
      current.driveMinutes + current.stayMinutes + remaining + stayMinutes >
      usableMin
    if (current.stops.length > 0 && (overDrive || overDaylight)) {
      days.push(current)
      current = emptyDay<T>()
    }
    current.driveMinutes += remaining
    current.stayMinutes += stayMinutes
    current.stops.push(stop)
  })

  // The run home. It has no stop on it but still costs days.
  const finalLeg = legs[stops.length]?.durationMin ?? 0
  if (finalLeg > 0) {
    const remaining = spendLongDrive(finalLeg)
    if (current.driveMinutes + remaining > maxDriveMin) {
      days.push(current)
      current = emptyDay<T>()
    }
    current.driveMinutes += remaining
  }

  closeIfUsed()
  return days
}

function emptyDay<T extends BudgetStop>(): PackedDay<T> {
  return { stops: [], driveMinutes: 0, stayMinutes: 0 }
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
