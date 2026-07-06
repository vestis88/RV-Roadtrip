import type { TripDay } from '@rv/shared'

export interface PacingViolation {
  reason: string
}

const MAX_DAY_FACTOR = 1.4
const FINAL_DAYS_FACTOR = 1.0
const FINAL_DAYS_COUNT = 2

/**
 * Validates a generated plan against Section 5's pacing rules: no day may
 * exceed 1.4x the target daily drive, the final two days must each be at
 * or under 1.0x the target (a relaxed finish), and rest days must stay at
 * the previous day's overnight rather than a fresh transit stop.
 */
export function validatePacing(days: TripDay[]): PacingViolation | null {
  const driveDays = days.filter((day) => day.type === 'drive' && day.drive)

  if (driveDays.length > 0) {
    const totalKm = driveDays.reduce(
      (sum, day) => sum + (day.drive?.distanceKm ?? 0),
      0,
    )
    const target = totalKm / driveDays.length

    for (const day of driveDays) {
      const distanceKm = day.drive?.distanceKm ?? 0
      if (distanceKm > target * MAX_DAY_FACTOR) {
        return {
          reason: `Day ${day.index} (${day.date}) drives ${distanceKm.toFixed(0)}km, exceeding ${MAX_DAY_FACTOR}x the ${target.toFixed(0)}km target daily drive.`,
        }
      }
    }

    const finalDays = days.slice(-FINAL_DAYS_COUNT)
    for (const day of finalDays) {
      const distanceKm = day.drive?.distanceKm ?? 0
      if (
        day.type === 'drive' &&
        day.drive &&
        distanceKm > target * FINAL_DAYS_FACTOR
      ) {
        return {
          reason: `Day ${day.index} (${day.date}) is one of the final ${FINAL_DAYS_COUNT} days but drives ${distanceKm.toFixed(0)}km, exceeding the ${target.toFixed(0)}km target required for a relaxed finish.`,
        }
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
