import {
  FieldValue,
  getFirestore,
  type DocumentReference,
} from 'firebase-admin/firestore'
import { onDocumentCreated } from 'firebase-functions/firestore'
import {
  activitySchema,
  haversineDistanceKm,
  restaurantSchema,
  tripDaySchema,
  type CorridorStop,
  type NamedPoint,
  type Trip,
  type TripDay,
} from '@rv/shared'
import { applyOvernightOptions } from './overnightOptions.js'
import {
  pacingWarnings,
  sightTimeFromHighlights,
  validatePacing,
} from './pacingValidator.js'
import { commitInChunks, type PendingWrite } from './firestoreBatch.js'
import {
  isPlanLockStale,
  planAliveFields,
  planRunEndedFields,
  wasSubmittedBeforeRunEnded,
} from './planLock.js'
import { buildCorridorStopWrites } from './corridorStops.js'
import { runReconcileCorridor } from './corridorReconciliation.js'
import { runInsertRestDay } from './insertRestDay.js'
import { runReplan, type ReplanContext } from './replanTrip.js'
import { googleRoutesApiKey } from './routesApi.js'
import {
  claudeApiKey,
  eagerDetailIndexes,
  generateSkeletonFromHighlights,
  planTrip,
  type PlanTripProgress,
} from './prompts/planTrip.js'
import { DETAIL_WINDOW_DAYS } from './dayDetail.js'
import type { RegionHighlightsResponse } from './prompts/planTripSchema.js'
import {
  buildRegionHighlightsFromCandidates,
  lockedRouteOrder,
} from './exploreCandidates.js'
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
  kind:
    | 'full'
    | 'replan'
    | 'insertRestDay'
    | 'reconcileCorridor'
    // Explore mode's commit step (2026-07-30): seeds the real generation
    // from the traveler's already-curated `candidate`/`locked` corridor
    // stops instead of running the (Claude-costed) highlights phase again —
    // see generateRealPlan's `highlights` param below.
    | 'fromExploreCandidates'
  replanContext?: ReplanContext
  // "Add a rest day" (implemented 2026-07-28): a purely mechanical reschedule
  // — no Claude/Places call — routed through this trigger anyway so it shares
  // the one-operation-per-trip cost guard below with replan/full.
  insertRestDayContext?: { afterDayId: string }
  // "Reorder the corridor" (phase 4a, implemented 2026-07-29): also purely
  // mechanical (no Claude call) but mutates real day data (dates, drive
  // legs), so it needs the same busy guard for the same reason
  // insertRestDay does. Extended in phase 4b to also add/remove a stop
  // (which DOES call Claude/Places for a newly-added one, and — unlike a
  // pure reorder — can change the trip's day count, hence
  // acceptEndDateChange: see corridorReconciliation.ts's own doc comment.
  reconcileCorridorContext?: {
    newStopOrder: string[]
    acceptEndDateChange?: boolean
  }
  // Segmented generation (2026-07-31, see GENERATION_TIME_BUDGET_MS below):
  // set only on a request this same trigger wrote for itself after running
  // out of time budget mid-generation ('full'/'fromExploreCandidates' only).
  // The trip is already correctly marked 'generating' by the invocation
  // that chained this one, so it skips re-claiming it via the busy guard —
  // it only confirms the trip is still actually 'generating' before
  // proceeding, rather than either re-claiming (which would spuriously
  // reject a genuine concurrent new request against the same trip) or
  // blindly trusting a stale/misfired continuation.
  isContinuation?: boolean
  status: string
}

// Segmented generation (2026-07-31): generatePlan's own Cloud Functions
// timeout (540s below — the hard ceiling for an event-driven trigger, not a
// value chosen for safety margin) can't grow to fit an arbitrarily long
// trip's worth of sequential Places/Routes lookups (resolveSkeletonDays is
// deliberately sequential across days — see its own doc comment). Rather
// than let a very long trip's generation get killed mid-flight with
// whatever's in flight lost, resolveSkeletonDays bails out once an
// invocation nears this budget and the days resolved so far are already
// durably staged (planCheckpoint.ts); the ~60s left below the hard ceiling
// covers this invocation's own final bookkeeping writes and the
// continuation planRequest it chains for itself. Only covers the
// day-resolution phase, not the upstream Claude skeleton call
// (planTrip/generateSkeletonFromHighlights) — that phase produces the whole
// skeleton in one shot with no partial-checkpoint support yet, so an
// extremely long trip could in principle still exceed budget before
// day-resolution even starts. Flagged as a known residual gap, not solved
// here — see master_plan.md.
const GENERATION_TIME_BUDGET_MS = 480_000

/**
 * How close a preserved candidate has to be to a newly-committed stop before
 * the two count as the same place. Generous, because it is comparing two
 * independent geocodes of the same town name rather than two real positions.
 */
const SAME_STOP_KM = 5

/**
 * Runs the real planning pipeline for a fresh trip: Claude proposes the
 * route shape (planTrip), then resolveSkeletonDays turns it into real,
 * enriched days (Routes + Places).
 *
 * Resumable (see planCheckpoint.ts): if a checkpoint from a prior, failed
 * attempt at these exact settings exists, the skeleton and any already-
 * resolved days are reused instead of redone — a retry only has to finish
 * whatever was left, not start over.
 *
 * `highlights`, when supplied (explore mode's commit step — see the
 * 'fromExploreCandidates' branch below), skips planTrip's own highlights
 * phase entirely and calls generateSkeletonFromHighlights directly with the
 * traveler's already-curated candidates — the one Claude call this whole
 * pipeline can actually avoid re-paying for. Folded into the checkpoint
 * hash (not just `computeSettingsHash(trip)` alone): a checkpoint saved
 * mid-explore-commit must never be resumed by a plain 'full' retry (or vice
 * versa) at the same settings — they'd produce different skeletons from the
 * same hash otherwise.
 *
 * `deadlineMs`, when supplied, is threaded through to resolveSkeletonDays so
 * it can stop early rather than risk this invocation's own Cloud Functions
 * timeout — see GENERATION_TIME_BUDGET_MS. The returned `complete` flag is
 * how the caller tells a genuinely finished plan apart from one that ran out
 * of time budget partway through the day-resolution phase.
 */
export async function generateRealPlan(
  trip: Trip,
  tripRef: DocumentReference,
  highlights?: RegionHighlightsResponse,
  deadlineMs?: number,
  lockedRoute?: string[],
): Promise<{ days: GeneratedDay[]; complete: boolean }> {
  const settingsHash = computeSettingsHash(trip) + (highlights ? ':explore' : '')
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
  } else {
    const onProgress = (progress: PlanTripProgress) => {
      tripRef
        .update({
          'planMeta.progressLabel': describePlanTripProgress(progress),
          ...planAliveFields(),
        })
        .catch((error: unknown) =>
          console.error('Failed to report planTrip progress', error),
        )
    }
    // The route is worked out for the whole trip; the activities and
    // restaurants only for the first few days. Everything past the window is
    // written `detailStatus: 'pending'` and filled in when it is opened —
    // see dayDetail.ts and detailDaysCallable.ts. On a sixty-day trip that
    // is three days of detail instead of sixty, and the replan that follows
    // costs three again rather than the entire remainder.
    const detailDayIndexes = eagerDetailIndexes(DETAIL_WINDOW_DAYS)
    skeleton = highlights
      ? await generateSkeletonFromHighlights({
          settings: trip.settings,
          notesFreeText: trip.notes.freeText,
          highlights,
          tripId: tripRef.id,
          detailDayIndexes,
          ...(lockedRoute?.length ? { lockedRoute } : {}),
          onProgress,
        })
      : await planTrip({
          settings: trip.settings,
          notesFreeText: trip.notes.freeText,
          tripId: tripRef.id,
          detailDayIndexes,
          ...(lockedRoute?.length ? { lockedRoute } : {}),
          onProgress,
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
    ...planAliveFields(),
    'planMeta.progressTotal': skeleton.days.length,
  })

  const remainingSkeletonDays = skeleton.days.slice(resumedDays.length)
  const newlyResolved = await resolveSkeletonDays(
    remainingSkeletonDays,
    startLocation,
    (count) => {
      tripRef
        .update({
          'planMeta.progressCurrent': resumedDays.length + count,
          ...planAliveFields(),
        })
        .catch((error: unknown) =>
          console.error('Failed to report day-resolution progress', error),
        )
    },
    (index, day) => stageGeneratedDay(tripRef, index, day),
    deadlineMs,
  )

  const days = [...resumedDays, ...newlyResolved]
  return { days, complete: days.length === skeleton.days.length }
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
  // Only the committed stops go — they describe the plan being replaced and
  // are rebuilt from the new days below. Everything else is the traveler's
  // research: candidates curated in explore mode, rescan finds, pins they
  // dropped themselves. That used to be deleted here too, unconditionally,
  // which meant the first generation destroyed every stop that hadn't made
  // the route — the whole "worth a detour, but not this time" set, gone, with
  // no way to get it back short of paying Claude to research it all again.
  //
  // It also made generation the odd one out: replanTrip deletes only stops
  // linked to days it is actually replacing (see its own staleCorridorStops),
  // and a stop with no linked days survives a replan untouched.
  const preservedStops = existingCorridorSnap.docs.filter(
    (stop) => (stop.data() as CorridorStop).status !== 'committed',
  )
  existingCorridorSnap.docs
    .filter((stop) => (stop.data() as CorridorStop).status === 'committed')
    .forEach((stop) => writes.push({ op: 'delete', ref: stop.ref }))

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
  // A preserved stop the new plan now routes through is the same place
  // listed twice: once as something still awaiting a decision, once as part
  // of the trip. The committed copy is the true one, so the preserved
  // duplicate goes. Matched on name or proximity, since a town candidate's
  // coordinates come from the highlights geocode and the day's from its own,
  // and the two land a street apart rather than identical.
  //
  // Proximity only counts for a stop that is itself a town, though — one with
  // no `baseTown`, meaning its own name is the place. A sights-led candidate
  // sits a couple of kilometres from the town it is seen from BY DESIGN (see
  // corridorStopSchema), so measuring it against overnight towns would delete
  // the Louisiana Museum for being near the night in Humlebæk, and with it
  // every reason the traveler was keeping it.
  const committedStops = writtenDays.map(({ day }) => day.overnight)
  preservedStops
    .filter((stop) => {
      const data = stop.data() as CorridorStop
      return committedStops.some(
        (committed) =>
          committed.name.trim().toLowerCase() === data.name.trim().toLowerCase() ||
          (!data.baseTown &&
            haversineDistanceKm(committed, { lat: data.lat, lng: data.lng }) <=
              SAME_STOP_KM),
      )
    })
    .forEach((stop) => writes.push({ op: 'delete', ref: stop.ref }))

  writes.push(...buildCorridorStopWrites(tripRef, writtenDays))
  await commitInChunks(db, writes)
}

/**
 * Runs a fresh ('full') or explore-commit ('fromExploreCandidates')
 * generation through to a `ready` trip, or — if `invocationDeadline` is hit
 * partway through day-resolution — chains a continuation planRequest and
 * leaves the trip `generating` for that next invocation to pick up (see
 * generateRealPlan's `complete` flag and isContinuation's own doc comment).
 * Extracted out of the trigger closure below the same way writeGeneratedDays
 * is (see its own doc comment) — the Functions emulator runs the compiled
 * bundle in its own process, so a test can't reach code that only runs
 * inside the onDocumentCreated closure by mocking it. Throws on any failure,
 * matching runReplan/runInsertRestDay/runReconcileCorridor's shape; the
 * trigger below is the only place that turns a throw into `planMeta.error`.
 */
export async function runFullGeneration(
  tripId: string,
  kind: PlanRequestData['kind'],
  invocationDeadline: number,
): Promise<{ chained: boolean }> {
  const db = getFirestore()
  const tripRef = db.collection('trips').doc(tripId)

  // Clear any progress left over from a previous run so the UI doesn't
  // briefly show a stale percentage before this run reaches the point
  // where it reports its own.
  await tripRef.update({
    'planMeta.status': 'generating',
    ...planAliveFields(),
    'planMeta.progressLabel': FieldValue.delete(),
    'planMeta.progressCurrent': FieldValue.delete(),
    'planMeta.progressTotal': FieldValue.delete(),
  })

  const tripSnap = await tripRef.get()
  const trip = tripSnap.data() as Trip

  // Both generate paths seed from the traveler's own curation whenever there
  // is any (2026-08-12). Only 'fromExploreCandidates' used to, which made the
  // two "Generate full plan" buttons behave completely differently for no
  // reason a traveler could see: committing from the explore map honoured
  // every vote, keep and rejection, while pressing the button on Trip Setup
  // ran Claude's curation phase again from scratch and silently threw all of
  // it away — and then writeGeneratedDays deleted the evidence.
  //
  // The difference that remains is what happens with NO curated stops:
  // 'full' researches the trip from nothing, which is exactly right for a
  // trip nobody has explored yet, while an explore commit with an empty
  // corridor is a mistake worth reporting.
  const candidatesSnap = await tripRef
    .collection('corridorStops')
    .where('status', 'in', ['candidate', 'locked'])
    .get()
  const curatedStops = candidatesSnap.docs.map(
    (doc) => doc.data() as CorridorStop,
  )
  const curated = buildRegionHighlightsFromCandidates(curatedStops)
  // The order the traveler actually committed to on the map, worked out by
  // Google against real roads. The route phase cannot derive it — a straight
  // line between two coordinates says nothing about whether the road exists
  // — and without it the detour that ordering removed comes straight back.
  const lockedRoute = lockedRouteOrder(curatedStops)
  if (kind === 'fromExploreCandidates' && curated.regions.length === 0) {
    throw new Error(
      'No candidate stops to build a plan from — explore a few first.',
    )
  }
  const highlights: RegionHighlightsResponse | undefined =
    curated.regions.length > 0 ? curated : undefined

  const { days, complete } = await generateRealPlan(
    trip,
    tripRef,
    highlights,
    invocationDeadline,
    lockedRoute,
  )

  if (!complete) {
    // Everything resolved so far is already durably staged
    // (planCheckpoint.ts) — hand the rest off to a fresh invocation with a
    // full new time budget rather than risk this one's own Cloud Functions
    // timeout finishing it off with nothing to show. isContinuation lets
    // that invocation skip the busy-guard claim (this trip is already
    // correctly marked 'generating' by this invocation) while still
    // confirming, when it runs, that the trip wasn't deleted or reset out
    // from under it in the meantime.
    await db.collection('planRequests').add({
      tripId,
      kind,
      status: 'pending',
      isContinuation: true,
    })
    return { chained: true }
  }

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
  // Advisory, not a gate — see pacingWarnings(). The curation is passed in
  // so the sight-load half of it (rule 7) has the timeNeeded estimates to
  // check against; without them every sight reads as a half-day.
  const warnings = pacingWarnings(
    days.map((d) => d.day),
    sightTimeFromHighlights(highlights),
  )

  await writeGeneratedDays(tripRef, days)
  // Where each night is actually spent, resolved for the whole trip at once
  // now that every day's town is known. Best-effort by design: it moves pins
  // and fills the picker, and a plan with every day still sitting on its town
  // centre is worse than one with them but far better than no plan at all.
  // Re-runnable on its own afterwards — see applyOvernightOptions.
  await applyOvernightOptions(tripRef).catch((error: unknown) => {
    console.warn('Overnight options pass failed; days keep their town points', error)
  })
  // Only now that the replacement is fully committed is the checkpoint
  // (skeleton + staged days) no longer needed for a future retry.
  await clearCheckpoint(tripRef)

  const driveDays = days.filter((d) => d.day.drive)
  const totalKm = driveDays.reduce(
    (sum, d) => sum + (d.day.drive?.distanceKm ?? 0),
    0,
  )
  const avgDriveMinutesPerDay = driveDays.length
    ? driveDays.reduce((sum, d) => sum + (d.day.drive?.durationMin ?? 0), 0) /
      driveDays.length
    : 0

  await tripRef.update({
    'planMeta.status': 'ready',
    'planMeta.totalKm': totalKm,
    'planMeta.avgDriveMinutesPerDay': avgDriveMinutesPerDay,
    'planMeta.generatedAt': new Date().toISOString(),
    'planMeta.pacingWarnings':
      warnings.length > 0 ? warnings : FieldValue.delete(),
    'planMeta.progressLabel': FieldValue.delete(),
    'planMeta.progressCurrent': FieldValue.delete(),
    'planMeta.progressTotal': FieldValue.delete(),
  })
  return { chained: false }
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
    // Measured from as close to actual invocation start as possible — see
    // GENERATION_TIME_BUDGET_MS.
    const invocationDeadline = Date.now() + GENERATION_TIME_BUDGET_MS

    // When this request was actually committed, as the server saw it — NOT
    // when this trigger got round to running. The two differ by however long
    // Eventarc took, and every duplicate-submission bug this guard exists to
    // stop lives in exactly that difference. Taken from the CloudEvent rather
    // than any field the client wrote, so it can't be spoofed or forgotten by
    // a new submitter. See wasSubmittedBeforeRunEnded.
    const parsedEventTime = Date.parse(event.time)
    const submittedAtMs = Number.isNaN(parsedEventTime) ? Date.now() : parsedEventTime

    // Cost guard: only one plan request may be active per trip at a time.
    // Rapid double-clicks on "Generate" (or a replan racing a full generate)
    // create multiple planRequest docs, but this transaction ensures only
    // the first to claim the trip's planMeta actually runs — the rest are
    // rejected immediately rather than piling up duplicate work. A chained
    // continuation (see isContinuation's own doc comment) skips claiming —
    // the invocation that chained it already holds the claim — and instead
    // just confirms the trip is still genuinely mid-generation.
    const claim = await db.runTransaction(async (tx) => {
      const tripSnap = await tx.get(tripRef)
      const meta = tripSnap.data()?.planMeta
      const currentStatus = meta?.status
      if (request.isContinuation) {
        // Deliberately checked before the duplicate guard below: a
        // continuation is written by the run that is still holding the
        // claim, so "submitted while a run was in progress" is its normal,
        // correct state rather than a duplicate.
        return currentStatus === 'generating' ? 'ok' : 'staleContinuation'
      }
      // The second half of the guard, and the one the status check above
      // cannot express: this request was written before a run that has since
      // finished, so it was submitted against a plan that no longer exists.
      // See wasSubmittedBeforeRunEnded for why comparing two already-fixed
      // server timestamps closes the window rather than narrowing it.
      if (wasSubmittedBeforeRunEnded(submittedAtMs, meta?.lastRunEndedAt)) {
        return 'superseded'
      }
      const isBusy = currentStatus === 'pending' || currentStatus === 'generating'
      // A busy claim that hasn't been touched in STALE_PLAN_LOCK_MS belongs
      // to a run that died without ever reaching its own error handler —
      // reclaimed rather than leaving the trip permanently ungeneratable.
      // See planLock.ts.
      if (isBusy && !isPlanLockStale(meta?.statusUpdatedAt)) return 'busy'
      tx.update(tripRef, { 'planMeta.status': 'pending', ...planAliveFields() })
      return 'ok'
    })

    if (claim !== 'ok') {
      const CLAIM_REFUSALS = {
        staleContinuation:
          'Chained continuation found the trip no longer generating — dropped.',
        superseded:
          'This trip was already being changed when this request was submitted — refused as a duplicate.',
        busy: 'Another plan request is already in progress for this trip.',
      } as const
      // Deliberately does not write planMeta at all — a refused request never
      // ran, so it must neither disturb the run that is in flight nor move
      // the lastRunEndedAt watermark that later requests are judged against.
      await snap.ref.update({ status: 'error', error: CLAIM_REFUSALS[claim] })
      return
    }

    // Everything below runs under the claim just taken. Wrapped in one
    // function with one exit so the run-ended watermark can be written in a
    // single `finally` below: the previous fix in this area was applied at
    // individual call sites and missed the rest, which is how the same class
    // of bug came back through a submitter nobody had thought of. A guard
    // that has to be remembered per branch is the same mistake one layer
    // down.
    const handleClaimedRequest = async (): Promise<{ chained: boolean }> => {
      if (request.kind === 'insertRestDay') {
        const afterDayId = request.insertRestDayContext?.afterDayId
        if (!afterDayId) {
          const message = 'insertRestDay request is missing insertRestDayContext'
          await tripRef.update({
            'planMeta.status': 'error',
            'planMeta.error': message,
          })
          await snap.ref.update({ status: 'error', error: message })
          return { chained: false }
        }
        try {
          await tripRef.update({
            'planMeta.status': 'generating',
            ...planAliveFields(),
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
        return { chained: false }
      }

      if (request.kind === 'reconcileCorridor') {
        const newStopOrder = request.reconcileCorridorContext?.newStopOrder
        if (!newStopOrder) {
          const message =
            'reconcileCorridor request is missing reconcileCorridorContext'
          await tripRef.update({
            'planMeta.status': 'error',
            'planMeta.error': message,
          })
          await snap.ref.update({ status: 'error', error: message })
          return { chained: false }
        }
        try {
          await tripRef.update({
            'planMeta.status': 'generating',
            ...planAliveFields(),
            'planMeta.progressLabel': FieldValue.delete(),
            'planMeta.progressCurrent': FieldValue.delete(),
            'planMeta.progressTotal': FieldValue.delete(),
          })
          await runReconcileCorridor(
            request.tripId,
            newStopOrder,
            request.reconcileCorridorContext?.acceptEndDateChange ?? false,
          )
          await snap.ref.update({ status: 'done' })
        } catch (error) {
          console.error('runReconcileCorridor failed', error)
          await tripRef.update({
            'planMeta.status': 'error',
            'planMeta.error': String(error),
            'planMeta.progressLabel': FieldValue.delete(),
            'planMeta.progressCurrent': FieldValue.delete(),
            'planMeta.progressTotal': FieldValue.delete(),
          })
          await snap.ref.update({ status: 'error', error: String(error) })
        }
        return { chained: false }
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
          return { chained: false }
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
        return { chained: false }
      }

      try {
        const outcome = await runFullGeneration(
          request.tripId,
          request.kind,
          invocationDeadline,
        )
        await snap.ref.update({ status: 'done' })
        // A chained continuation carries the claim forward, so this run has
        // not actually ended — see the watermark write below.
        return outcome
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
      return { chained: false }
    }

    // The watermark every later request is judged against — see
    // wasSubmittedBeforeRunEnded. Written whether this run succeeded or
    // failed, because either way the plan a request submitted beforehand was
    // aimed at is gone. Skipped only when the work was handed to a chained
    // continuation, since the run has not ended in that case.
    let chained = false
    try {
      const outcome = await handleClaimedRequest()
      chained = outcome.chained
    } finally {
      if (!chained) {
        await tripRef
          .update(planRunEndedFields())
          .catch((error: unknown) =>
            console.error('Failed to record the end of a plan run', error),
          )
      }
    }
  },
)
