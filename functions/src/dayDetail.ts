import type { Activity, LatLng, Restaurant } from '@rv/shared'
import { enrichActivities, enrichRestaurantsForMeal } from './placesApi.js'
import type { PlanTripSkeletonDay } from './prompts/planTripSchema.js'

/**
 * How many days are worked out at a time — the rolling window.
 *
 * Three is what a traveler can actually act on: today, tomorrow, the day
 * after. Small enough that opening a day costs one short Claude call plus
 * that many days of Places lookups, and bigger windows buy nothing, because
 * the days past it are exactly the ones a replan would throw away again.
 */
export const DETAIL_WINDOW_DAYS = 3

/**
 * Where a day's activities and restaurants should be searched for.
 *
 * The rule is the outline prompt's own default (planTripPrompt.ts): "drive
 * after that day's activities and dinner, arriving at the new overnight town
 * late". So on the default 'evening' slot the day is actually spent where it
 * STARTED — last night's town — and the new overnight is only reached once
 * everything else is done. Only a 'morning'/'midday' slot means the drive
 * already happened, making the new town the right anchor. A rest day never
 * moves, and its two points are the same place anyway.
 *
 * Extracted (2026-08-16) because detail is no longer resolved only here: the
 * lazy path works from stored days rather than from a skeleton, and the two
 * getting a day's anchor subtly different would put one day's restaurants in
 * the wrong town with nothing to show it had happened.
 */
export function dayActivityAnchor(input: {
  type: 'drive' | 'rest'
  driveSlot?: 'morning' | 'midday' | 'evening'
  /** This day's own town. */
  townPoint: LatLng
  /** The town the day started in — last night's. */
  arrivedFrom: LatLng
}): LatLng {
  return input.type === 'drive' && (input.driveSlot ?? 'evening') !== 'evening'
    ? input.townPoint
    : input.arrivedFrom
}

/**
 * Turns one day's proposed activity/restaurant names into real, Places-backed
 * entries. Shared by generation and by the lazy per-day path so both resolve
 * a day the same way.
 */
export async function enrichDayDetail(
  detail: {
    activities: NonNullable<PlanTripSkeletonDay['activities']>
    restaurants: NonNullable<PlanTripSkeletonDay['restaurants']>
  },
  near: LatLng,
): Promise<{ activities: Activity[]; restaurants: Restaurant[] }> {
  // Shared across the three meals so the same restaurant cannot be proposed
  // for breakfast and again for dinner.
  const excludeIds = new Set<string>()
  const [activities, breakfast, lunch, dinner] = await Promise.all([
    enrichActivities(detail.activities, near),
    enrichRestaurantsForMeal(
      detail.restaurants.filter((r) => r.meal === 'breakfast'),
      'breakfast',
      near,
      excludeIds,
    ),
    enrichRestaurantsForMeal(
      detail.restaurants.filter((r) => r.meal === 'lunch'),
      'lunch',
      near,
      excludeIds,
    ),
    enrichRestaurantsForMeal(
      detail.restaurants.filter((r) => r.meal === 'dinner'),
      'dinner',
      near,
      excludeIds,
    ),
  ])
  return { activities, restaurants: [...breakfast, ...lunch, ...dinner] }
}
