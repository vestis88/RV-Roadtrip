import type {
  Activity,
  LatLng,
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
  // Set when the overnight stop's coordinates are already known and trusted
  // — a corridor stop the traveler placed directly (AddCorridorStopForm) or
  // located via a rescan (phase 4b of the persistent-corridor overhaul:
  // reconciling that stop into a real day). Skips the geocodeQuery lookup
  // below entirely: re-geocoding by name/town/country text search could
  // silently resolve to a DIFFERENT point than the one the traveler actually
  // pinned (e.g. a same-named town elsewhere), which would defeat the whole
  // point of letting them place it themselves. Every other caller (fresh
  // generation, replan) has no such prior point and geocodes as before.
  knownOvernight?: { lat: number; lng: number; country?: string },
): Promise<{ generated: GeneratedDay; nextLocation: NamedPoint }> {
  let overnight: OvernightStop
  let drive: TripDay['drive']
  // Where the day's *town* is, as distinct from where its bed is. Since the
  // overnight below moved off the town centre and onto a campsite that can
  // be up to OVERNIGHT_CAMPSITE_MAX_KM outside it, everything that means
  // "the place this day is about" — what activities are searched near, what
  // the next day is planned relative to — has to keep using this rather
  // than follow the bed out to a field by the motorway.
  let townPoint = { lat: currentLocation.lat, lng: currentLocation.lng }

  if (skDay.type === 'drive') {
    const point = knownOvernight ?? (await geocodeQuery(
      `${skDay.overnight.name}, ${skDay.overnight.town}, ${skDay.overnight.country}`,
      currentLocation,
    ))
    if (!point) {
      throw new Error(
        `Could not geocode overnight stop "${skDay.overnight.name}, ${skDay.overnight.town}"`,
      )
    }
    // `point` is the town, and a text search for a town answers with the
    // town: "Berlin, Berlin, DE" resolves to 52.52,13.405, an intersection
    // in Mitte. Moving the overnight off that centroid and onto somewhere an
    // RV can actually sleep is applyOvernightOptions' job, in a single pass
    // once every day's location is known — the corridor-wide OSM query it
    // depends on wants all of them at once, and this resolver only ever sees
    // one day at a time. Until it runs, the overnight is the town.
    townPoint = { lat: point.lat, lng: point.lng }
    overnight = {
      name: skDay.overnight.name,
      lat: point.lat,
      lng: point.lng,
      country: knownOvernight?.country ?? skDay.overnight.country,
      ...(skDay.overnight.campsiteSuggestion
        ? { campsiteSuggestion: skDay.overnight.campsiteSuggestion }
        : {}),
    }
    const leg = await computeRouteLeg(currentLocation, point)
    drive = {
      fromName: currentLocation.name,
      toName: overnight.name,
      distanceKm: leg.distanceKm,
      durationMin: leg.durationMin,
      slot: skDay.drive?.slot ?? 'evening',
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

  const near = dayActivityAnchor({
    type: skDay.type,
    driveSlot: skDay.drive?.slot,
    townPoint,
    arrivedFrom: { lat: currentLocation.lat, lng: currentLocation.lng },
  })

  // No detail asked for: the route for this day is decided and its
  // activities/restaurants are somebody else's problem, later. See
  // planTripSkeletonDaySchema and detailDaysCallable.ts.
  const detail = skDay.activities &&
    skDay.restaurants && {
      activities: skDay.activities,
      restaurants: skDay.restaurants,
    }
  const { activities, restaurants } = detail
    ? await enrichDayDetail(detail, near)
    : { activities: [], restaurants: [] }

  return {
    generated: {
      day: {
        index: skDay.index,
        date: skDay.date,
        type: skDay.type,
        overnight,
        townAnchor: townPoint,
        drive,
        summary: skDay.summary,
        ...(skDay.extraTimeReason
          ? { extraTimeReason: skDay.extraTimeReason }
          : {}),
        ...(skDay.highlightReason
          ? { highlightReason: skDay.highlightReason }
          : {}),
        ...(skDay.sights?.length ? { sights: skDay.sights } : {}),
        // Absent means ready — see tripDaySchema.detailStatus. Only a day
        // deliberately left undetailed says so.
        ...(detail ? {} : { detailStatus: 'pending' as const }),
      },
      activities,
      restaurants,
    },
    // The town, not the campsite: this seeds the next day's geocoding bias
    // and its activity anchor, and both want "the place we are", not the
    // specific field we slept in. The next drive leg's origin is a few km
    // off as a result — the same order of approximation it always carried,
    // and much cheaper than pulling every following day's restaurant search
    // out towards a motorway junction.
    nextLocation: { name: overnight.name, ...townPoint },
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
  // Awaited (unlike onDayResolved, a fire-and-forget progress counter also
  // used by replanTrip.ts) — fires right when a day resolves, before the
  // next one starts, so a caller can durably stage the day (e.g.
  // generatePlan.ts's checkpoint) before risking a crash on the next one.
  // A day's whole point is surviving a crash between it and the next day,
  // so staging can't itself be fire-and-forget.
  onDayGenerated?: (index: number, day: GeneratedDay) => void | Promise<void>,
  // Segmented generation (2026-07-31): when set, resolution stops before
  // starting any further day once past this wall-clock deadline, returning
  // whatever's been resolved (and already staged via onDayGenerated) so
  // far — deliberately short of `skeletonDays.length` rather than running
  // into generatePlan's own Cloud Functions timeout with nothing durably
  // saved for the days still in flight. The caller (generateRealPlan)
  // compares the returned count against the full skeleton to detect this
  // and chain a continuation planRequest — see generatePlan.ts. Omitted by
  // every caller that doesn't need this (replanTrip.ts's remainder is
  // short enough not to risk it), so this stays a pure no-op addition for
  // them.
  deadlineMs?: number,
): Promise<GeneratedDay[]> {
  const days: GeneratedDay[] = []
  let currentLocation = startLocation
  for (const skDay of skeletonDays) {
    if (deadlineMs !== undefined && Date.now() > deadlineMs) break
    const { generated, nextLocation } = await resolveSkeletonDay(
      skDay,
      currentLocation,
    )
    days.push(generated)
    currentLocation = nextLocation
    onDayResolved?.(days.length)
    await onDayGenerated?.(skDay.index, generated)
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
