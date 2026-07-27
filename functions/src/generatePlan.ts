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
  type Trip,
} from '@rv/shared'
import { validatePacing } from './pacingValidator.js'
import { runReplan, type ReplanContext } from './replanTrip.js'
import { googleRoutesApiKey } from './routesApi.js'
import { claudeApiKey, planTrip } from './prompts/planTrip.js'
import { googlePlacesApiKey } from './placesApi.js'
import {
  describePlanTripProgress,
  resolveSkeletonDays,
  type GeneratedDay,
} from './planPipeline.js'

interface PlanRequestData {
  tripId: string
  kind: 'full' | 'replan'
  replanContext?: ReplanContext
  status: string
}

/**
 * Runs the real planning pipeline for a fresh trip: Claude proposes the
 * route shape (planTrip), then resolveSkeletonDays turns it into real,
 * enriched days (Routes + Places).
 */
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

  return resolveSkeletonDays(skeleton.days, trip.settings.startPoint, (count) => {
    tripRef
      .update({ 'planMeta.progressCurrent': count })
      .catch((error: unknown) =>
        console.error('Failed to report day-resolution progress', error),
      )
  })
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
          'planMeta.progressLabel': FieldValue.delete(),
          'planMeta.progressCurrent': FieldValue.delete(),
          'planMeta.progressTotal': FieldValue.delete(),
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

      // Structural check only: no day may exceed the traveler's own
      // maxDriveHoursPerDay by more than the tolerance, and rest days stay
      // put. Unlike a replan (which only re-paces the remainder), a fresh
      // generation has no prior plan to preserve — if it fails this, there's
      // nothing to salvage, so this is a hard failure rather than a retry.
      const violation = validatePacing(
        days.map((d) => d.day),
        trip.settings.maxDriveHoursPerDay,
      )
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
