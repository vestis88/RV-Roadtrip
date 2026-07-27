import { createHash } from 'node:crypto'
import { FieldValue, type DocumentReference } from 'firebase-admin/firestore'
import { activitySchema, restaurantSchema, tripDaySchema, type Trip } from '@rv/shared'
import { planTripSkeletonSchema, type PlanTripSkeleton } from './prompts/planTripSchema.js'
import type { GeneratedDay } from './planPipeline.js'

const STAGING_COLLECTION = 'generationStaging'

/**
 * Resumable generation (backlog item, implemented 2026-07-27): generatePlan
 * previously built the whole plan in memory and wrote it once at the very
 * end, so any failure — even the pacing check, which only runs after every
 * Places/Routes lookup completes — discarded everything, and a retry redid
 * the entire pipeline from zero (all three Claude phases plus every Places/
 * Routes lookup, even for days that had already resolved fine). This module
 * lets a retry resume from the last completed step instead, as long as
 * settings haven't changed since the checkpoint was written.
 *
 * Scoped to fresh generation only (generatePlan.ts) — a replan's remainder
 * is short enough that redoing it from scratch isn't the expensive case
 * this exists for.
 */
export function computeSettingsHash(trip: Trip): string {
  const payload = JSON.stringify({
    settings: trip.settings,
    notes: trip.notes.freeText,
  })
  return createHash('sha256').update(payload).digest('hex')
}

export interface LoadedCheckpoint {
  skeleton: PlanTripSkeleton
  resumedDays: GeneratedDay[]
}

/**
 * Returns the resumable state if a valid checkpoint exists for these exact
 * settings, or null if this should start clean (no prior attempt, or the
 * traveler changed settings since the last one — the staged days would
 * belong to a different generation and must not be silently reused).
 */
export async function loadCheckpoint(
  tripRef: DocumentReference,
  trip: Trip,
  settingsHash: string,
): Promise<LoadedCheckpoint | null> {
  const checkpoint = trip.planMeta.checkpoint
  if (!checkpoint) return null

  if (checkpoint.settingsHash !== settingsHash || !checkpoint.skeleton) {
    await clearCheckpoint(tripRef)
    return null
  }

  const skeleton = planTripSkeletonSchema.parse(checkpoint.skeleton)
  const stagedSnap = await tripRef
    .collection(STAGING_COLLECTION)
    .orderBy('day.index')
    .get()
  const resumedDays = stagedSnap.docs.map((doc) => doc.data() as GeneratedDay)
  return { skeleton, resumedDays }
}

export async function saveSkeletonCheckpoint(
  tripRef: DocumentReference,
  settingsHash: string,
  skeleton: PlanTripSkeleton,
): Promise<void> {
  await tripRef.update({ 'planMeta.checkpoint': { settingsHash, skeleton } })
}

/**
 * Awaited by resolveSkeletonDays before it moves on to the next day (the
 * whole point is durably surviving a crash between this day and the next
 * one) — but a staging write failing doesn't fail the current run, since
 * staging only matters for a *future* retry, not this one; it's logged and
 * swallowed instead of thrown.
 */
export async function stageGeneratedDay(
  tripRef: DocumentReference,
  index: number,
  day: GeneratedDay,
): Promise<void> {
  tripDaySchema.parse(day.day)
  day.activities.forEach((activity) => activitySchema.parse(activity))
  day.restaurants.forEach((restaurant) => restaurantSchema.parse(restaurant))
  try {
    await tripRef
      .collection(STAGING_COLLECTION)
      .doc(String(index).padStart(4, '0'))
      .set(day)
  } catch (error) {
    console.error(`Failed to stage generated day ${index}`, error)
  }
}

export async function clearCheckpoint(tripRef: DocumentReference): Promise<void> {
  const staleSnap = await tripRef.collection(STAGING_COLLECTION).get()
  const batch = tripRef.firestore.batch()
  staleSnap.docs.forEach((doc) => batch.delete(doc.ref))
  batch.update(tripRef, { 'planMeta.checkpoint': FieldValue.delete() })
  await batch.commit()
}
