import type { TripDay } from '@rv/shared'

export interface PacingViolation {
  reason: string
}

// The trip-average-based 1.4x/1.0x targets this used to hard-enforce were
// an internal artifact of the generated route, not something the traveler
// asked for — a single day that legitimately needs more driving to reach a
// worthwhile stop (see each day's highlightReason) would kill the entire
// generation with no way to accept the tradeoff. The only drive-length
// constraint enforced as a hard failure now is the one the traveler
// actually set: maxDriveHoursPerDay. TOLERANCE gives Claude/Routes some
// slack (traffic, rounding) before treating it as broken rather than just
// "longer than requested".
const MAX_DRIVE_HOURS_TOLERANCE = 1.5

/**
 * Validates a generated plan's structural correctness: no day may drive
 * more than MAX_DRIVE_HOURS_TOLERANCE x the traveler's own stated
 * maxDriveHoursPerDay, and rest days must stay at the previous day's
 * overnight rather than land in a fresh transit stop. Softer pacing
 * preferences (the outline's own target distance, a relaxed finish) are
 * left as prompt guidance for the generator rather than a hard post-hoc
 * gate — see each day's highlightReason for why a longer day was chosen.
 */
export function validatePacing(
  days: TripDay[],
  maxDriveHoursPerDay: number,
): PacingViolation | null {
  const driveDays = days.filter((day) => day.type === 'drive' && day.drive)
  const maxDriveMinutes = maxDriveHoursPerDay * 60 * MAX_DRIVE_HOURS_TOLERANCE

  for (const day of driveDays) {
    const durationMin = day.drive?.durationMin ?? 0
    if (durationMin > maxDriveMinutes) {
      return {
        reason: `Day ${day.index} (${day.date}) drives ${(durationMin / 60).toFixed(1)}h, exceeding ${MAX_DRIVE_HOURS_TOLERANCE}x the requested ${maxDriveHoursPerDay}h/day max.`,
      }
    }
  }

  for (let i = 1; i < days.length; i++) {
    const day = days[i]
    const previous = days[i - 1]
    if (day.type === 'rest' && day.overnight.name !== previous.overnight.name) {
      return {
        reason: `Day ${day.index} (${day.date}) is a rest day but its overnight location (${day.overnight.name}) differs from the previous day's (${previous.overnight.name}) — rest days must stay in place, not land in a fresh transit town.`,
      }
    }
  }

  return null
}

/**
 * How far above the trip's own average the required pace may drift before
 * the remainder counts as a slog rather than a busy stretch. 1.4x mirrors
 * the outline's own per-day ceiling (PACING_RULES rule 3): a trip that has
 * to sustain, for days on end, what that rule allows as an occasional
 * maximum is one that spent something earlier it could not afford.
 */
const BACKLOG_PACE_FACTOR = 1.4

/**
 * Below this there is no distribution to speak of. On three drive days one
 * stop legitimately IS a third of the trip, and no ratio can tell "wasteful"
 * apart from "that is why we came" — the prompt is the only honest lever at
 * that length.
 */
const MIN_DRIVE_DAYS_FOR_WARNING = 4

/**
 * How many drive days must remain for a raised pace to mean anything. One
 * long final day is a long final day; validatePacing already bounds it by
 * the traveler's own maxDriveHoursPerDay, and rule 3 by the target distance.
 * A slog is a stretch, so this asks for one.
 */
const MIN_REMAINING_DRIVE_DAYS = 3

/**
 * Non-blocking counterpart to validatePacing. Reports the point at which
 * the trip has fallen furthest behind its own schedule — where what is left
 * to drive has got ahead of the days left to drive it.
 *
 * Deliberately NOT a minimum distance per day. The first version of this
 * flagged any day covering less than half the average, which is the wrong
 * question and gets more wrong the longer the trip: on a two-month trip
 * short days and long stays are the point, and there is no distance a day
 * owes anybody. What actually went wrong on the trip that prompted this —
 * Helsingborg to Berlin, two of three days spent 45km from the start — was
 * not that a day was short. It was that the shortness was never paid for
 * until the end, and then all at once.
 *
 * So the measure is the trip's own remaining budget: after each day, how
 * much distance is left against how many drive days are left, compared to
 * what the trip needed to average from the outset. That ratio starts at
 * exactly 1.0 by construction and only climbs when days come in under
 * average, which makes it a direct read on back-loading and completely
 * indifferent to how any individual day is spent. A slow first week
 * balanced by a slow rest of the trip never trips it; a slow first week
 * followed by a forced march does.
 *
 * One warning per trip, at the worst point, rather than one per day: the
 * shape is a single fact about the trip, and listing every day that
 * contributed to it would bury it.
 *
 * Advice, not a verdict — the plan is written either way. The trip-average
 * targets that used to be hard-enforced were removed for good reason (see
 * MAX_DRIVE_HOURS_TOLERANCE above), and the traveler is the one who knows
 * whether the stop was worth what it cost the end of the trip.
 */
export function pacingWarnings(days: TripDay[]): string[] {
  const driveDays = days.filter((day) => day.type === 'drive' && day.drive)
  if (driveDays.length < MIN_DRIVE_DAYS_FOR_WARNING) return []

  const distances = driveDays.map((day) => day.drive?.distanceKm ?? 0)
  const totalKm = distances.reduce((sum, km) => sum + km, 0)
  if (totalKm <= 0) return []

  const targetKm = totalKm / driveDays.length

  let covered = 0
  let worst: { day: TripDay; requiredKm: number; remainingDays: number } | null =
    null
  for (let i = 0; i < driveDays.length; i++) {
    covered += distances[i]
    const remainingDays = driveDays.length - 1 - i
    if (remainingDays < MIN_REMAINING_DRIVE_DAYS) break

    const requiredKm = (totalKm - covered) / remainingDays
    if (requiredKm > targetKm * BACKLOG_PACE_FACTOR) {
      if (!worst || requiredKm > worst.requiredKm) {
        worst = { day: driveDays[i], requiredKm, remainingDays }
      }
    }
  }
  if (!worst) return []

  return [
    `By the end of day ${worst.day.index + 1} (${worst.day.date}) this trip still has ${Math.round(worst.requiredKm)} km a day left to drive across its remaining ${worst.remainingDays} driving days — well above the ${Math.round(targetKm)} km a day it needs on average. The early stops are worth what they cost only if you're happy with that finish; otherwise this is the point to drop one or add a day.`,
  ]
}
