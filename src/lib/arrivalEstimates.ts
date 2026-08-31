import { packStopsIntoDays } from './tripBudget'
import type { CorridorStopWithId } from '../hooks/useCorridorStops'
import type { TripDayWithId } from '../hooks/useTripDays'

/**
 * Roughly when you will get to each kept stop.
 *
 * Requested 2026-08-24: "Locked in activities should get an estimated date
 * based on what is on our current route."
 *
 * Everything needed is already here — `packStopsIntoDays` assigns every kept
 * stop to a day, against the traveler's own `maxDriveHoursPerDay` and the
 * real Google legs. This turns those day indices into dates.
 *
 * TWO DECISIONS, both of which would be wrong the other way round.
 *
 * **The count starts from today once the trip is running.** Counting from
 * `startDate` would say a stop lands on the 22nd when it is already the
 * 24th — an estimate that is confidently behind the traveler is worse than
 * none. Done stops are already excluded from the packing, so the remaining
 * estimates pull forward as things are ticked off, which is the behaviour
 * that makes this worth showing at all.
 *
 * **A stop already on a real day takes that day's date, while that day is
 * still ahead.** The packing is a fast greedy estimate; the day plan is the
 * committed answer, and letting both claim to say "when" is how the header
 * and the itinerary came to disagree before. But a committed day in the
 * PAST, on a stop nobody marked done, is not an answer to "when will we get
 * there" — see the override below.
 */
export interface ArrivalEstimate {
  /** YYYY-MM-DD. */
  date: string
  /** True when this came from a real day rather than the packing. */
  committed: boolean
}

export function arrivalEstimates(input: {
  routeStops: CorridorStopWithId[]
  legs?: { durationMin: number }[]
  days: TripDayWithId[]
  startDate: string
  maxDriveHoursPerDay: number
  today: string
}): Map<string, ArrivalEstimate> {
  const { legs = [], days, startDate, today } = input
  // Filtered here rather than trusted to the caller. `packStopsIntoDays`
  // packs whatever it is handed — it is `tripBudget` that drops done stops
  // before calling it — so a function whose whole promise is "what is left"
  // has to do that itself or quietly depend on every caller remembering.
  const routeStops = input.routeStops.filter((stop) => !stop.doneAt)
  const estimates = new Map<string, ArrivalEstimate>()
  if (!startDate) return estimates

  const dateByDayId = new Map(days.map((day) => [day.id, day.date]))

  // Counting starts from whichever is later: the trip's own start, or today.
  // Before the trip that is startDate; during it, today.
  const base = today > startDate ? today : startDate

  const packed = packStopsIntoDays({
    stops: routeStops,
    legs,
    maxDriveHoursPerDay: input.maxDriveHoursPerDay,
  })
  packed.forEach((day, index) => {
    for (const stop of day.stops) {
      estimates.set(stop.id, { date: addDays(base, index), committed: false })
    }
  })

  // A committed day overrides the estimate for the stop that owns it —
  // UNLESS that day has already been and gone.
  //
  // Reported 2026-08-31 with a screenshot: a stop on the route ahead, not
  // marked done, dated 2026-08-20 — eleven days in the past — while the
  // banner directly above it said "These days are from an earlier plan".
  // Both statements were produced by this file: the committed date won
  // outright, and the day it came from belonged to a plan the traveler had
  // long since driven past.
  //
  // A day in the past on a stop that is NOT done is not a commitment; it is
  // the residue of an older plan, and it is the one case where the packing
  // — which counts forward from today — is strictly better informed. So the
  // committed date wins only while it is still ahead. Done stops never
  // reach here (they are filtered above), so this cannot swallow the date
  // something was actually done on.
  for (const stop of routeStops) {
    const committedDate = (stop.linkedDayIds ?? [])
      .map((dayId) => dateByDayId.get(dayId))
      .filter((date): date is string => !!date)
      .sort()[0]
    if (committedDate && committedDate >= today) {
      estimates.set(stop.id, { date: committedDate, committed: true })
    }
  }

  return estimates
}

/** Adds `n` days to a YYYY-MM-DD string, in UTC — see dateShift.addDays. */
function addDays(date: string, n: number): string {
  const next = new Date(
    new Date(`${date}T00:00:00Z`).getTime() + n * 86_400_000,
  )
  return next.toISOString().slice(0, 10)
}
