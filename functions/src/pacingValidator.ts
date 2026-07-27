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
