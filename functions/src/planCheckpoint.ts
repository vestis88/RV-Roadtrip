import { createHash } from 'node:crypto'
import { FieldValue, type DocumentReference } from 'firebase-admin/firestore'
import { activitySchema, restaurantSchema, tripDaySchema, type Trip } from '@rv/shared'
import { planTripSkeletonSchema, type PlanTripSkeleton } from './prompts/planTripSchema.js'
import { commitInChunks } from './firestoreBatch.js'
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

/**
 * Drops the checkpoint once the real days are durably committed.
 *
 * Chunked via commitInChunks like every other multi-doc write in this
 * codebase (see firestoreBatch.ts): one staged doc per day plus the trip
 * update, which a long enough trip could push past Firestore's 500-op
 * batch cap — the exact cap that machinery exists for.
 *
 * Never throws. This runs *after* writeGeneratedDays has already committed
 * the real, correct plan, so a failure here means "cleanup of a
 * now-redundant cache failed", not "generation failed" — but it used to
 * propagate into generatePlan's outer catch, which marked a perfectly good
 * generation as `status: 'error'` and showed the traveler a failure for a
 * trip that had in fact generated fine. Logged and swallowed instead; the
 * leftover staging docs are inert (a later run overwrites them, and
 * loadCheckpoint validates the settings hash before reusing anything).
 */
export async function clearCheckpoint(tripRef: DocumentReference): Promise<void> {
  try {
    const staleSnap = await tripRef.collection(STAGING_COLLECTION).get()
    await commitInChunks(
      tripRef.firestore,
      staleSnap.docs.map((doc) => ({ op: 'delete', ref: doc.ref })),
    )
    // Separate from the chunked deletes rather than widening PendingWrite
    // with an 'update' op for this one call site — it's a single operation
    // with no batching concern of its own.
    await tripRef.update({ 'planMeta.checkpoint': FieldValue.delete() })
  } catch (error) {
    console.error('Failed to clear plan checkpoint — generation itself succeeded', error)
  }
}
