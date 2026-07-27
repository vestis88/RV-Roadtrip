import type {
  Activity,
  NamedPoint,
  OvernightStop,
  Restaurant,
  TripDay,
} from '@rv/shared'
import { computeRouteLeg } from './routesApi.js'
import type { PlanTripProgress } from './prompts/planTrip.js'
import type { PlanTripSkeletonDay } from './prompts/planTripSchema.js'
import {
  enrichActivities,
  enrichRestaurantsForMeal,
  geocodeQuery,
} from './placesApi.js'

export interface GeneratedDay {
  day: Omit<TripDay, 'drive'> & { drive?: TripDay['drive'] }
  activities: Activity[]
  restaurants: Restaurant[]
}

/**
 * Turns one skeleton day (town names only, per 6.1's contract — Claude
 * never invents ratings/URLs/coordinates) into a fully resolved day: real
 * coordinates for the overnight stop (geocoded via Places, biased near the
 * previous stop so same-named towns in different countries don't collide),
 * a real drive leg via the Routes API for 'drive' days, and Places-enriched
 * activities/restaurants. Rest days reuse the previous stop's exact
 * coordinates rather than re-geocoding — they're the same physical place.
 *
 * Shared between a fresh generatePlan run and a replanTrip remainder — both
 * need to turn a planTrip() skeleton into real, persistable days the same
 * way, just starting from a different location and day-index offset.
 */
export async function resolveSkeletonDay(
  skDay: PlanTripSkeletonDay,
  currentLocation: NamedPoint,
): Promise<{ generated: GeneratedDay; nextLocation: NamedPoint }> {
  let overnight: OvernightStop
  let drive: TripDay['drive']

  if (skDay.type === 'drive') {
    const geocoded = await geocodeQuery(
      `${skDay.overnight.name}, ${skDay.overnight.town}, ${skDay.overnight.country}`,
      currentLocation,
    )
    if (!geocoded) {
      throw new Error(
        `Could not geocode overnight stop "${skDay.overnight.name}, ${skDay.overnight.town}"`,
      )
    }
    overnight = {
      name: skDay.overnight.name,
      lat: geocoded.lat,
      lng: geocoded.lng,
      country: skDay.overnight.country,
      ...(skDay.overnight.campsiteSuggestion
        ? { campsiteSuggestion: skDay.overnight.campsiteSuggestion }
        : {}),
    }
    const leg = await computeRouteLeg(currentLocation, geocoded)
    drive = {
      fromName: currentLocation.name,
      toName: overnight.name,
      distanceKm: leg.distanceKm,
      durationMin: leg.durationMin,
      slot: skDay.drive?.slot ?? 'morning',
      ...(leg.polyline ? { polyline: leg.polyline } : {}),
    }
  } else {
    overnight = {
      name: skDay.overnight.name || currentLocation.name,
      lat: currentLocation.lat,
      lng: currentLocation.lng,
      country: skDay.overnight.country,
      ...(skDay.overnight.campsiteSuggestion
        ? { campsiteSuggestion: skDay.overnight.campsiteSuggestion }
        : {}),
    }
  }

  const near = { lat: overnight.lat, lng: overnight.lng }
  const excludeIds = new Set<string>()
  const [activities, breakfast, lunch, dinner] = await Promise.all([
    enrichActivities(skDay.activities, near),
    enrichRestaurantsForMeal(
      skDay.restaurants.filter((r) => r.meal === 'breakfast'),
      'breakfast',
      near,
      excludeIds,
    ),
    enrichRestaurantsForMeal(
      skDay.restaurants.filter((r) => r.meal === 'lunch'),
      'lunch',
      near,
      excludeIds,
    ),
    enrichRestaurantsForMeal(
      skDay.restaurants.filter((r) => r.meal === 'dinner'),
      'dinner',
      near,
      excludeIds,
    ),
  ])

  return {
    generated: {
      day: {
        index: skDay.index,
        date: skDay.date,
        type: skDay.type,
        overnight,
        drive,
        summary: skDay.summary,
        ...(skDay.extraTimeReason
          ? { extraTimeReason: skDay.extraTimeReason }
          : {}),
        ...(skDay.highlightReason
          ? { highlightReason: skDay.highlightReason }
          : {}),
      },
      activities,
      restaurants: [...breakfast, ...lunch, ...dinner],
    },
    nextLocation: { name: overnight.name, lat: overnight.lat, lng: overnight.lng },
  }
}

/**
 * Resolves a whole skeleton in order — each day's geocoding bias and
 * drive-leg origin depend on the previous day's resolved location, so this
 * is NOT parallelized across days (a multi-week trip can mean hundreds of
 * sequential Places calls; see generatePlan's timeoutSeconds for how
 * that's accommodated).
 */
export async function resolveSkeletonDays(
  skeletonDays: PlanTripSkeletonDay[],
  startLocation: NamedPoint,
  onDayResolved?: (resolvedCount: number) => void,
): Promise<GeneratedDay[]> {
  const days: GeneratedDay[] = []
  let currentLocation = startLocation
  for (const skDay of skeletonDays) {
    const { generated, nextLocation } = await resolveSkeletonDay(
      skDay,
      currentLocation,
    )
    days.push(generated)
    currentLocation = nextLocation
    onDayResolved?.(days.length)
  }
  return days
}

export function describePlanTripProgress(progress: PlanTripProgress): string {
  switch (progress.phase) {
    case 'highlights':
      return 'Researching the best stops along your route…'
    case 'outline':
      return 'Planning your route…'
    case 'detail':
      return `Planning day-by-day details (${progress.chunkIndex}/${progress.chunkCount})…`
  }
}
