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
 * A drive day covering less than this fraction of the route's own average
 * day is flagged. Half is deliberately generous: a 60%-of-average day is a
 * normal consequence of stops not being evenly spaced, while a day at 20%
 * of average has effectively not moved the trip along at all.
 */
const SHORT_DAY_FRACTION = 0.5

/**
 * Below this there is no meaningful "average day" to compare against — on a
 * two-drive-day trip every split looks lopsided, and warning about it would
 * be noise on exactly the trips where the traveler can see the whole thing
 * at a glance anyway.
 */
const MIN_DRIVE_DAYS_FOR_WARNING = 3

/**
 * Non-blocking counterpart to validatePacing, added 2026-08-12 after a
 * 3-day Helsingborg→Berlin trip spent two of its days in Helsingør, 45km
 * from the start, because somewhere interesting sat just past the start
 * point. Nothing in the plan was invalid: every rule the generator is held
 * to is an upper bound (don't drive more than X), so a plan that barely
 * moves passes every one of them.
 *
 * The trip-average targets that used to be enforced were removed for good
 * reason (see the comment on MAX_DRIVE_HOURS_TOLERANCE above) — a day that
 * legitimately needs to be unusual shouldn't kill the whole generation. So
 * this returns advice, not a verdict: the plan is written either way, and
 * the traveler decides whether the stop earned the day. The generator is
 * separately told to avoid this (PACING_RULES rule 6 in
 * prompts/planTripPrompt.ts); this catches the times it doesn't listen.
 *
 * The trip's final drive day is exempt: it's the arrival at the endpoint,
 * and a short relaxed finish is intended, not a wasted day.
 */
export function pacingWarnings(days: TripDay[]): string[] {
  const driveDays = days.filter((day) => day.type === 'drive' && day.drive)
  if (driveDays.length < MIN_DRIVE_DAYS_FOR_WARNING) return []

  const totalKm = driveDays.reduce(
    (sum, day) => sum + (day.drive?.distanceKm ?? 0),
    0,
  )
  if (totalKm <= 0) return []

  const targetKm = totalKm / driveDays.length
  const shortDays = driveDays
    .slice(0, -1)
    .filter((day) => (day.drive?.distanceKm ?? 0) < targetKm * SHORT_DAY_FRACTION)

  return shortDays.map(
    (day) =>
      `Day ${day.index + 1} (${day.date}) only covers ${Math.round(day.drive?.distanceKm ?? 0)} km, to ${day.overnight.name} — under half the ${Math.round(targetKm)} km this route averages per driving day. Worth checking that the stop is worth a whole day of the trip.`,
  )
}
