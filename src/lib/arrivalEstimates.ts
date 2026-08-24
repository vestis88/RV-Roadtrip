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
 * **A stop already on a real day takes that day's date.** The packing is a
 * fast greedy estimate; the day plan is the committed answer. Letting both
 * claim to say "when" is exactly how the header and the itinerary came to
 * disagree before, so where a committed date exists it wins outright.
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

  // A committed day overrides the estimate for the stop that owns it.
  for (const stop of routeStops) {
    const committedDate = (stop.linkedDayIds ?? [])
      .map((dayId) => dateByDayId.get(dayId))
      .filter((date): date is string => !!date)
      .sort()[0]
    if (committedDate) {
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
