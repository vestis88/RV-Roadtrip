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
  type NamedPoint,
  type Trip,
  type TripDay,
} from '@rv/shared'
import { validatePacing } from './pacingValidator.js'
import { commitInChunks, type PendingWrite } from './firestoreBatch.js'
import { buildCorridorStopWrites } from './corridorStops.js'
import { runInsertRestDay } from './insertRestDay.js'
import { runReplan, type ReplanContext } from './replanTrip.js'
import { googleRoutesApiKey } from './routesApi.js'
import {
  claudeApiKey,
  generateRegionHighlights,
  generateSkeletonFromHighlights,
  planTrip,
} from './prompts/planTrip.js'
import {
  buildHighlightsBackbone,
  generateEnrichedHighlights,
} from './prompts/enrichHighlights.js'
import {
  regionHighlightsResponseSchema,
  type RegionHighlightsResponse,
} from './prompts/planTripSchema.js'
import { googlePlacesApiKey } from './placesApi.js'
import {
  describePlanTripProgress,
  resolveSkeletonDays,
  type GeneratedDay,
} from './planPipeline.js'
import {
  clearCheckpoint,
  computeSettingsHash,
  loadCheckpoint,
  saveSkeletonCheckpoint,
  stageGeneratedDay,
} from './planCheckpoint.js'

interface PlanRequestData {
  tripId: string
  kind: 'full' | 'replan' | 'continueFromHighlights' | 'insertRestDay'
  replanContext?: ReplanContext
  // "Add a rest day" (implemented 2026-07-28): a purely mechanical reschedule
  // — no Claude/Places call — routed through this trigger anyway so it shares
  // the one-operation-per-trip cost guard below with replan/full.
  insertRestDayContext?: { afterDayId: string }
  // Interactive/transparent route planning (implemented 2026-07-27):
  reviewHighlights?: boolean
  editedHighlights?: unknown
  reviewNote?: string
  // Opt-in web-search enrichment before the review pause (implemented
  // 2026-07-28) — only meaningful alongside reviewHighlights, which the
  // Settings screen enforces by forcing that box on when this one is ticked.
  searchForMoreStops?: boolean
  status: string
}

/**
 * How generateRealPlan should obtain its skeleton — either the default
 * end-to-end pipeline (planTrip, resumable via checkpoint), or resuming
 * into just phases 2-3 with highlights the traveler already reviewed and
 * edited during a review-pause request.
 */
type SkeletonSource =
  | { kind: 'fresh' }
  | {
      kind: 'fromHighlights'
      highlights: Awaited<ReturnType<typeof generateRegionHighlights>>
      notesFreeText: string
    }

/**
 * Runs just the highlights phase and pauses there for review (implemented
 * 2026-07-27) — exported/testable the same way generateRealPlan is, since
 * both run inside a Cloud Function trigger that a test can't mock into
 * directly (the Functions emulator runs the compiled bundle in its own
 * process; vi.mock only reaches code running in the test process itself).
 */
export async function pauseForHighlightsReview(
  trip: Trip,
  tripRef: DocumentReference,
  searchForMoreStops = false,
): Promise<void> {
  const curated = await generateRegionHighlights({
    settings: trip.settings,
    notesFreeText: trip.notes.freeText,
  })

  const highlights = searchForMoreStops
    ? await withWebSearchFinds(trip, curated)
    : curated

  await tripRef.update({
    'planMeta.status': 'awaiting-highlights-review',
    'planMeta.pendingHighlights': highlights,
    'planMeta.progressLabel': FieldValue.delete(),
  })
}

/**
 * Runs the opt-in web-search enrichment pass and appends whatever survives
 * its distance filter as extra regions on the curated highlights (rather
 * than merging finds into existing region objects — they're a distinct set
 * of suggestions and read more honestly grouped as their own regions, each
 * candidate already tagged source: 'search' for the review panel to label).
 *
 * Never fails the pause. This is a secondary, explicitly-requested extra on
 * top of a primary flow that works perfectly well without it, so a web
 * search error, an exhausted schema-validation retry, or a Places outage
 * degrades to "you get the curated highlights" — the same principle as the
 * review panel's map falling back to a straight line when Directions fails,
 * rather than showing no route at all.
 */
async function withWebSearchFinds(
  trip: Trip,
  curated: RegionHighlightsResponse,
): Promise<RegionHighlightsResponse> {
  try {
    const backbone = buildHighlightsBackbone(trip.settings, curated)
    const extraRegions = await generateEnrichedHighlights({
      settings: trip.settings,
      notesFreeText: trip.notes.freeText,
      highlights: curated,
      backbone,
    })
    if (extraRegions.length === 0) return curated
    return { regions: [...curated.regions, ...extraRegions] }
  } catch (error) {
    console.error(
      'Highlights web-search enrichment failed — continuing with the curated highlights only',
      error,
    )
    return curated
  }
}

/**
 * Runs the real planning pipeline for a fresh trip: Claude proposes the
 * route shape (planTrip, or generateSkeletonFromHighlights if resuming from
 * a reviewed-highlights request), then resolveSkeletonDays turns it into
 * real, enriched days (Routes + Places).
 *
 * Resumable (see planCheckpoint.ts): if a checkpoint from a prior, failed
 * attempt at these exact settings exists, the skeleton and any already-
 * resolved days are reused instead of redone — a retry only has to finish
 * whatever was left, not start over. `source` only decides how the
 * skeleton is obtained when there's no checkpoint to resume from.
 */
export async function generateRealPlan(
  trip: Trip,
  tripRef: DocumentReference,
  source: SkeletonSource = { kind: 'fresh' },
): Promise<GeneratedDay[]> {
  const settingsHash = computeSettingsHash(trip)
  const checkpoint = await loadCheckpoint(tripRef, trip, settingsHash)

  let skeleton
  let resumedDays: GeneratedDay[]
  let startLocation: NamedPoint

  if (checkpoint) {
    skeleton = checkpoint.skeleton
    resumedDays = checkpoint.resumedDays
    const lastOvernight = resumedDays.at(-1)?.day.overnight
    startLocation = lastOvernight
      ? { name: lastOvernight.name, lat: lastOvernight.lat, lng: lastOvernight.lng }
      : trip.settings.startPoint
  } else if (source.kind === 'fromHighlights') {
    skeleton = await generateSkeletonFromHighlights({
      settings: trip.settings,
      notesFreeText: source.notesFreeText,
      highlights: source.highlights,
      onProgress: (progress) => {
        tripRef
          .update({ 'planMeta.progressLabel': describePlanTripProgress(progress) })
          .catch((error: unknown) =>
            console.error('Failed to report planTrip progress', error),
          )
      },
    })
    await saveSkeletonCheckpoint(tripRef, settingsHash, skeleton)
    resumedDays = []
    startLocation = trip.settings.startPoint
  } else {
    skeleton = await planTrip({
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
    await saveSkeletonCheckpoint(tripRef, settingsHash, skeleton)
    resumedDays = []
    startLocation = trip.settings.startPoint
  }

  // Reported from here on — this is the slow, sequential part (a Places/
  // Routes round-trip per day) that a "generating" spinner alone gives no
  // sense of progress through on a multi-week trip.
  await tripRef.update({
    'planMeta.progressLabel': FieldValue.delete(),
    'planMeta.progressCurrent': resumedDays.length,
    'planMeta.progressTotal': skeleton.days.length,
  })

  const remainingSkeletonDays = skeleton.days.slice(resumedDays.length)
  const newlyResolved = await resolveSkeletonDays(
    remainingSkeletonDays,
    startLocation,
    (count) => {
      tripRef
        .update({ 'planMeta.progressCurrent': resumedDays.length + count })
        .catch((error: unknown) =>
          console.error('Failed to report day-resolution progress', error),
        )
    },
    (index, day) => stageGeneratedDay(tripRef, index, day),
  )

  return [...resumedDays, ...newlyResolved]
}

/**
 * Replaces every existing day (and its activities/restaurants) with `days`,
 * chunked across Firestore batches. Exported/directly-testable the same way
 * generateRealPlan is — the Functions emulator runs the compiled bundle in
 * its own process, so a test can't reach code that only runs inside the
 * onDocumentCreated trigger closure below by mocking it.
 *
 * A trip being (re)generated may already have a full set of days from a
 * previous generation — e.g. the traveler edited the destination in Trip
 * Setup and clicked "Generate" again. Every existing day is cleared before
 * the fresh ones are written; skipping this left old and new
 * activities/restaurants sitting side by side under whichever dates
 * happened to coincide, since each new one was written with a fresh
 * auto-generated doc ID rather than overwriting anything. Reported as: a
 * regenerated trip's map/day view still showing a previous plan's
 * activities at the new stops. A brand new trip has no existing days, so
 * this is a no-op for a first-ever generation.
 */
export async function writeGeneratedDays(
  tripRef: DocumentReference,
  days: GeneratedDay[],
): Promise<void> {
  const db = getFirestore()
  const [existingDaysSnap, existingCorridorSnap] = await Promise.all([
    tripRef.collection('days').get(),
    tripRef.collection('corridorStops').get(),
  ])
  const existingDayContents = await Promise.all(
    existingDaysSnap.docs.map(async (doc) => {
      const [activities, restaurants] = await Promise.all([
        doc.ref.collection('activities').get(),
        doc.ref.collection('restaurants').get(),
      ])
      return { doc, activities, restaurants }
    }),
  )

  const writes: PendingWrite[] = []
  for (const { doc, activities, restaurants } of existingDayContents) {
    activities.docs.forEach((a) => writes.push({ op: 'delete', ref: a.ref }))
    restaurants.docs.forEach((r) => writes.push({ op: 'delete', ref: r.ref }))
    writes.push({ op: 'delete', ref: doc.ref })
  }
  existingCorridorSnap.docs.forEach((stop) =>
    writes.push({ op: 'delete', ref: stop.ref }),
  )

  const writtenDays: { ref: DocumentReference; day: TripDay }[] = []
  for (const { day, activities, restaurants } of days) {
    tripDaySchema.parse(day)
    const dayRef = tripRef.collection('days').doc()
    writes.push({ op: 'set', ref: dayRef, data: day })
    writtenDays.push({ ref: dayRef, day })
    for (const activity of activities) {
      activitySchema.parse(activity)
      writes.push({
        op: 'set',
        ref: dayRef.collection('activities').doc(),
        data: activity,
      })
    }
    for (const restaurant of restaurants) {
      restaurantSchema.parse(restaurant)
      writes.push({
        op: 'set',
        ref: dayRef.collection('restaurants').doc(),
        data: restaurant,
      })
    }
  }
  writes.push(...buildCorridorStopWrites(tripRef, writtenDays))
  await commitInChunks(db, writes)
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
    // 'awaiting-highlights-review' blocks a new 'full'/'replan' request the
    // same way — the trip is paused waiting on the traveler's edits, not
    // free to restart — but must NOT block the 'continueFromHighlights'
    // request that resumes it; that's the one request this exact status
    // exists to let through.
    const claimed = await db.runTransaction(async (tx) => {
      const tripSnap = await tx.get(tripRef)
      const currentStatus = tripSnap.data()?.planMeta?.status
      const isBusy = currentStatus === 'pending' || currentStatus === 'generating'
      const isPausedForReview = currentStatus === 'awaiting-highlights-review'
      if (isBusy || (isPausedForReview && request.kind !== 'continueFromHighlights')) {
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

    if (request.kind === 'full' && request.reviewHighlights) {
      try {
        await tripRef.update({
          'planMeta.status': 'generating',
          'planMeta.progressLabel': FieldValue.delete(),
          'planMeta.progressCurrent': FieldValue.delete(),
          'planMeta.progressTotal': FieldValue.delete(),
        })

        const tripSnap = await tripRef.get()
        const trip = tripSnap.data() as Trip

        await pauseForHighlightsReview(
          trip,
          tripRef,
          request.searchForMoreStops === true,
        )
        await snap.ref.update({ status: 'done' })
      } catch (error) {
        console.error('generatePlan (highlights review) failed', error)
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

    if (request.kind === 'insertRestDay') {
      const afterDayId = request.insertRestDayContext?.afterDayId
      if (!afterDayId) {
        const message = 'insertRestDay request is missing insertRestDayContext'
        await tripRef.update({
          'planMeta.status': 'error',
          'planMeta.error': message,
        })
        await snap.ref.update({ status: 'error', error: message })
        return
      }
      try {
        await tripRef.update({
          'planMeta.status': 'generating',
          'planMeta.progressLabel': FieldValue.delete(),
          'planMeta.progressCurrent': FieldValue.delete(),
          'planMeta.progressTotal': FieldValue.delete(),
        })
        await runInsertRestDay(request.tripId, afterDayId)
        await snap.ref.update({ status: 'done' })
      } catch (error) {
        console.error('runInsertRestDay failed', error)
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
      // where it reports its own. pendingHighlights is cleared too — a
      // 'continueFromHighlights' request is done with it the moment
      // generation resumes.
      await tripRef.update({
        'planMeta.status': 'generating',
        'planMeta.progressLabel': FieldValue.delete(),
        'planMeta.progressCurrent': FieldValue.delete(),
        'planMeta.progressTotal': FieldValue.delete(),
        'planMeta.pendingHighlights': FieldValue.delete(),
      })

      const tripSnap = await tripRef.get()
      const trip = tripSnap.data() as Trip

      const source: SkeletonSource =
        request.kind === 'continueFromHighlights'
          ? {
              kind: 'fromHighlights',
              highlights: regionHighlightsResponseSchema.parse(
                request.editedHighlights,
              ),
              notesFreeText: request.reviewNote
                ? `${trip.notes.freeText}\n\nMust include (from highlights review): ${request.reviewNote}`
                : trip.notes.freeText,
            }
          : { kind: 'fresh' }

      const days = await generateRealPlan(trip, tripRef, source)

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

      await writeGeneratedDays(tripRef, days)
      // Only now that the replacement is fully committed is the checkpoint
      // (skeleton + staged days) no longer needed for a future retry.
      await clearCheckpoint(tripRef)

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
