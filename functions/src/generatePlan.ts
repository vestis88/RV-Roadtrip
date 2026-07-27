import {
  FieldValue,
  getFirestore,
  type DocumentReference,
} from 'firebase-admin/firestore'
import { onDocumentCreated } from 'firebase-functions/firestore'
import {
  activitySchema,
  restaurantSchema,
  tripDaySchema,
  type Activity,
  type NamedPoint,
  type OvernightStop,
  type Restaurant,
  type Trip,
  type TripDay,
} from '@rv/shared'
import { validatePacing } from './pacingValidator.js'
import { runReplan, type ReplanContext } from './replanTrip.js'
import { computeRouteLeg, googleRoutesApiKey } from './routesApi.js'
import {
  claudeApiKey,
  planTrip,
  type PlanTripProgress,
} from './prompts/planTrip.js'
import type { PlanTripSkeletonDay } from './prompts/planTripSchema.js'
import {
  enrichActivities,
  enrichRestaurantsForMeal,
  geocodeQuery,
  googlePlacesApiKey,
} from './placesApi.js'

interface PlanRequestData {
  tripId: string
  kind: 'full' | 'replan'
  replanContext?: ReplanContext
  status: string
}

interface GeneratedDay {
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
 */
async function resolveSkeletonDay(
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
      },
      activities,
      restaurants: [...breakfast, ...lunch, ...dinner],
    },
    nextLocation: { name: overnight.name, lat: overnight.lat, lng: overnight.lng },
  }
}

/**
 * Runs the real planning pipeline for a trip: Claude proposes the route
 * shape (planTrip), then each day is resolved to real coordinates/distances
 * (Routes + Places geocoding) and enriched with real activities/restaurants
 * (Places). Days are resolved in order — each one's geocoding bias and
 * drive-leg origin depend on the previous day's resolved location — but
 * enrichment (Places lookups) is NOT parallelized across days, since a
 * multi-week trip can mean hundreds of sequential Places calls; see the
 * generatePlan timeout for how that's accommodated.
 */
function describePlanTripProgress(progress: PlanTripProgress): string {
  switch (progress.phase) {
    case 'highlights':
      return 'Researching the best stops along your route…'
    case 'outline':
      return 'Planning your route…'
    case 'detail':
      return `Planning day-by-day details (${progress.chunkIndex}/${progress.chunkCount})…`
  }
}

async function generateRealPlan(
  trip: Trip,
  tripRef: DocumentReference,
): Promise<GeneratedDay[]> {
  const skeleton = await planTrip({
    settings: trip.settings,
    notesFreeText: trip.notes.freeText,
    onProgress: (progress) => {
      tripRef
        .update({ 'planMeta.progressLabel': describePlanTripProgress(progress) })
        .catch((error: unknown) =>
          console.error('Failed to report planTrip progress', error),
        )
    },
  })

  // Reported from here on — this is the slow, sequential part (a Places/
  // Routes round-trip per day) that a "generating" spinner alone gives no
  // sense of progress through on a multi-week trip.
  await tripRef.update({
    'planMeta.progressLabel': FieldValue.delete(),
    'planMeta.progressCurrent': 0,
    'planMeta.progressTotal': skeleton.days.length,
  })

  const days: GeneratedDay[] = []
  let currentLocation: NamedPoint = trip.settings.startPoint
  for (const skDay of skeleton.days) {
    const { generated, nextLocation } = await resolveSkeletonDay(
      skDay,
      currentLocation,
    )
    days.push(generated)
    currentLocation = nextLocation
    await tripRef.update({ 'planMeta.progressCurrent': days.length })
  }
  return days
}

export const generatePlan = onDocumentCreated(
  {
    document: 'planRequests/{requestId}',
    secrets: [googleRoutesApiKey, claudeApiKey, googlePlacesApiKey],
    // A multi-week trip means Claude's own generation plus hundreds of
    // sequential Places lookups (5 activities + 9 restaurants per day) —
    // comfortably past the 60s default for anything beyond a few days.
    timeoutSeconds: 540,
  },
  async (event) => {
    const snap = event.data
    if (!snap) return

    const request = snap.data() as PlanRequestData
    const db = getFirestore()
    const tripRef = db.collection('trips').doc(request.tripId)

    // Cost guard: only one plan request may be active per trip at a time.
    // Rapid double-clicks on "Generate" (or a replan racing a full generate)
    // create multiple planRequest docs, but this transaction ensures only
    // the first to claim the trip's planMeta actually runs — the rest are
    // rejected immediately rather than piling up duplicate work.
    const claimed = await db.runTransaction(async (tx) => {
      const tripSnap = await tx.get(tripRef)
      const currentStatus = tripSnap.data()?.planMeta?.status
      if (currentStatus === 'pending' || currentStatus === 'generating') {
        return false
      }
      tx.update(tripRef, { 'planMeta.status': 'pending' })
      return true
    })

    if (!claimed) {
      await snap.ref.update({
        status: 'error',
        error: 'Another plan request is already in progress for this trip.',
      })
      return
    }

    if (request.kind === 'replan') {
      if (!request.replanContext) {
        await tripRef.update({
          'planMeta.status': 'error',
          'planMeta.error': 'replan request is missing replanContext',
        })
        await snap.ref.update({
          status: 'error',
          error: 'replan request is missing replanContext',
        })
        return
      }
      try {
        await runReplan(request.tripId, request.replanContext)
        await snap.ref.update({ status: 'done' })
      } catch (error) {
        console.error('runReplan failed', error)
        await tripRef.update({
          'planMeta.status': 'error',
          'planMeta.error': String(error),
        })
        await snap.ref.update({ status: 'error', error: String(error) })
      }
      return
    }

    try {
      // Clear any progress left over from a previous run so the UI doesn't
      // briefly show a stale percentage before this run reaches the point
      // where it reports its own.
      await tripRef.update({
        'planMeta.status': 'generating',
        'planMeta.progressLabel': FieldValue.delete(),
        'planMeta.progressCurrent': FieldValue.delete(),
        'planMeta.progressTotal': FieldValue.delete(),
      })

      const tripSnap = await tripRef.get()
      const trip = tripSnap.data() as Trip

      const days = await generateRealPlan(trip, tripRef)

      // Section 5 pacing rules: no day > 1.4x target, final 2 days <= 1.0x
      // target, rest days stay put. Unlike a replan (which only re-paces
      // the remainder), a fresh generation has no prior plan to preserve —
      // if Claude's route violates pacing, there's nothing to salvage, so
      // this is a hard failure rather than a retry (never show a bad plan).
      const violation = validatePacing(days.map((d) => d.day))
      if (violation) {
        throw new Error(`Pacing validation failed: ${violation.reason}`)
      }

      const batch = db.batch()
      for (const { day, activities, restaurants } of days) {
        tripDaySchema.parse(day)
        const dayRef = tripRef.collection('days').doc(day.date)
        batch.set(dayRef, day)
        for (const activity of activities) {
          activitySchema.parse(activity)
          batch.set(dayRef.collection('activities').doc(), activity)
        }
        for (const restaurant of restaurants) {
          restaurantSchema.parse(restaurant)
          batch.set(dayRef.collection('restaurants').doc(), restaurant)
        }
      }
      await batch.commit()

      const driveDays = days.filter((d) => d.day.drive)
      const totalKm = driveDays.reduce(
        (sum, d) => sum + (d.day.drive?.distanceKm ?? 0),
        0,
      )
      const avgDriveMinutesPerDay = driveDays.length
        ? driveDays.reduce(
            (sum, d) => sum + (d.day.drive?.durationMin ?? 0),
            0,
          ) / driveDays.length
        : 0

      await tripRef.update({
        'planMeta.status': 'ready',
        'planMeta.totalKm': totalKm,
        'planMeta.avgDriveMinutesPerDay': avgDriveMinutesPerDay,
        'planMeta.generatedAt': new Date().toISOString(),
        'planMeta.progressLabel': FieldValue.delete(),
        'planMeta.progressCurrent': FieldValue.delete(),
        'planMeta.progressTotal': FieldValue.delete(),
      })
      await snap.ref.update({ status: 'done' })
    } catch (error) {
      console.error('generatePlan failed', error)
      await tripRef.update({
        'planMeta.status': 'error',
        'planMeta.error': String(error),
        'planMeta.progressLabel': FieldValue.delete(),
        'planMeta.progressCurrent': FieldValue.delete(),
        'planMeta.progressTotal': FieldValue.delete(),
      })
      await snap.ref.update({ status: 'error', error: String(error) })
    }
  },
)
