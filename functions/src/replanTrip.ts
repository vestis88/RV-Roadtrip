import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import {
  activitySchema,
  restaurantSchema,
  tripDaySchema,
  type LatLng,
  type NamedPoint,
  type Trip,
  type TripDay,
  type TripSettings,
} from '@rv/shared'
import { validatePacing } from './pacingValidator.js'
import { describePlanTripProgress, resolveSkeletonDays } from './planPipeline.js'
import { planTrip } from './prompts/planTrip.js'

export interface ReplanContext {
  currentLocation: LatLng
  today: string
  completedRefPaths: string[]
  remainingEndDate: string
  remainingEndPoint: NamedPoint
  changeRequestText?: string
  lockedDayIds?: string[]
}

/**
 * Re-plans the remainder of a trip from the traveler's current location to
 * the remaining end point/date, running the same real Claude + Places/Routes
 * pipeline generatePlan.ts uses for a fresh trip (planTrip + resolveSkeletonDays)
 * rather than a placeholder. Past days and any explicitly locked days are
 * preserved untouched; everything else in the future is replaced.
 *
 * Generation happens BEFORE any existing day is deleted: a failure partway
 * through planTrip/resolution/pacing validation throws with the trip's
 * existing days still fully intact, rather than leaving the trip with its
 * future chopped off and nothing to replace it (the exact failure mode a
 * hard-coded, near-infallible fixture could never hit, but real generation
 * can).
 */
export async function runReplan(
  tripId: string,
  context: ReplanContext,
): Promise<void> {
  const db = getFirestore()
  const tripRef = db.collection('trips').doc(tripId)

  const tripSnapBeforeReplan = await tripRef.get()
  const trip = tripSnapBeforeReplan.data() as Trip

  await tripRef.update({
    'planMeta.status': 'generating',
    'planMeta.progressLabel': FieldValue.delete(),
    'planMeta.progressCurrent': FieldValue.delete(),
    'planMeta.progressTotal': FieldValue.delete(),
  })

  const lockedDayIds = new Set(context.lockedDayIds ?? [])
  const daysSnap = await tripRef.collection('days').orderBy('date').get()
  // Past days are historical fact; locked days were explicitly pinned by the
  // user via the "Request changes" flow. Both survive the replan untouched.
  const pastDocs = daysSnap.docs.filter(
    (doc) =>
      (doc.data() as TripDay).date < context.today || lockedDayIds.has(doc.id),
  )
  const futureDocs = daysSnap.docs.filter(
    (doc) =>
      (doc.data() as TripDay).date >= context.today && !lockedDayIds.has(doc.id),
  )

  const currentLocationPoint: NamedPoint = {
    name: 'Current location',
    lat: context.currentLocation.lat,
    lng: context.currentLocation.lng,
  }
  const remainderSettings: TripSettings = {
    ...trip.settings,
    startDate: context.today,
    endDate: context.remainingEndDate,
    startPoint: currentLocationPoint,
    endPoint: context.remainingEndPoint,
  }
  const notesFreeText = context.changeRequestText
    ? `${trip.notes.freeText}\n\nChange request for the remainder of the trip: ${context.changeRequestText}`
    : trip.notes.freeText

  const skeleton = await planTrip({
    settings: remainderSettings,
    notesFreeText,
    onProgress: (progress) => {
      tripRef
        .update({ 'planMeta.progressLabel': describePlanTripProgress(progress) })
        .catch((error: unknown) =>
          console.error('Failed to report replan progress', error),
        )
    },
  })

  // Reported from here on — this is the slow, sequential part (a Places/
  // Routes round-trip per day) that a "generating" spinner alone gives no
  // sense of progress through on a multi-day remainder.
  await tripRef.update({
    'planMeta.progressLabel': FieldValue.delete(),
    'planMeta.progressCurrent': 0,
    'planMeta.progressTotal': skeleton.days.length,
  })

  // The skeleton's own indices start at 0 (it has no idea past/locked days
  // already occupy 0..startIndex-1) — offset them to continue the trip's
  // real day numbering.
  const startIndex = pastDocs.length
  const reindexedDays = skeleton.days.map((day, i) => ({
    ...day,
    index: startIndex + i,
  }))

  const resolved = await resolveSkeletonDays(
    reindexedDays,
    currentLocationPoint,
    (count) => {
      tripRef
        .update({ 'planMeta.progressCurrent': count })
        .catch((error: unknown) =>
          console.error('Failed to report replan day-resolution progress', error),
        )
    },
  )

  // remainderSettings spans every calendar day from today through
  // remainingEndDate, but a locked day can legitimately sit anywhere in
  // that range (the "Request changes" UI lets the user lock any day, not
  // just ones at the boundary) — planTrip has no notion of "skip this
  // date", so the outline may propose a day that lands on an already-locked
  // date. Locked must mean untouched, no exceptions, so any such collision
  // is dropped here rather than allowed to overwrite it. (Known limitation:
  // the route itself isn't planned around the locked day's location, since
  // Claude isn't told about it — only protected from being overwritten.)
  const preservedDates = new Set(pastDocs.map((doc) => doc.id))
  const daysToWrite = resolved.filter((r) => !preservedDates.has(r.day.date))
  if (daysToWrite.length !== resolved.length) {
    console.warn(
      `runReplan: dropped ${resolved.length - daysToWrite.length} generated day(s) that collided with an already-locked/past date`,
    )
  }

  // Past days are historical fact and can't be re-paced; per 6.2, only the
  // regenerated remainder needs to satisfy the pacing check.
  const remainderDays = daysToWrite.map((r) => r.day)
  const violation = validatePacing(remainderDays, trip.settings.maxDriveHoursPerDay)
  if (violation) {
    throw new Error(`Pacing validation failed: ${violation.reason}`)
  }

  // Only now — once the replacement is known-good — touch existing docs.
  const batch = db.batch()
  for (const doc of futureDocs) {
    const [activities, restaurants] = await Promise.all([
      doc.ref.collection('activities').get(),
      doc.ref.collection('restaurants').get(),
    ])
    activities.docs.forEach((a) => batch.delete(a.ref))
    restaurants.docs.forEach((r) => batch.delete(r.ref))
    batch.delete(doc.ref)
  }
  for (const { day, activities, restaurants } of daysToWrite) {
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

  const allDays: TripDay[] = [
    ...pastDocs.map((doc) => doc.data() as TripDay),
    ...remainderDays,
  ]

  const driveDays = allDays.filter((day) => day.drive)
  const totalKm = driveDays.reduce(
    (sum, day) => sum + (day.drive?.distanceKm ?? 0),
    0,
  )
  const avgDriveMinutesPerDay = driveDays.length
    ? driveDays.reduce((sum, day) => sum + (day.drive?.durationMin ?? 0), 0) /
      driveDays.length
    : 0

  const now = new Date().toISOString()
  await tripRef.update({
    'planMeta.status': 'ready',
    'planMeta.totalKm': totalKm,
    'planMeta.avgDriveMinutesPerDay': avgDriveMinutesPerDay,
    'planMeta.generatedAt': now,
    'planMeta.lastReplanAt': now,
    'planMeta.progressLabel': FieldValue.delete(),
    'planMeta.progressCurrent': FieldValue.delete(),
    'planMeta.progressTotal': FieldValue.delete(),
  })
}
