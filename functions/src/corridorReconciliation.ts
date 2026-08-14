import Anthropic from '@anthropic-ai/sdk'
import {
  FieldValue,
  getFirestore,
  type DocumentReference,
  type QueryDocumentSnapshot,
} from 'firebase-admin/firestore'
import {
  corridorStopSchema,
  tripDaySchema,
  type CorridorStop,
  type NamedPoint,
  type ReconcileDayChange,
  type Trip,
  type TripDay,
} from '@rv/shared'
import { pacingWarnings, validatePacing } from './pacingValidator.js'
import { computeRouteLeg } from './routesApi.js'
import { commitInChunks, type PendingWrite } from './firestoreBatch.js'
import { resolveSkeletonDay } from './planPipeline.js'
import { claudeApiKey, generateChunkDetail } from './prompts/planTrip.js'
import type { RouteOutlineDay } from './prompts/planTripSchema.js'

/** Adds `n` calendar days to a `YYYY-MM-DD` date string (UTC, see insertRestDay.ts's addOneDay for why). */
function addDays(date: string, n: number): string {
  const next = new Date(new Date(`${date}T00:00:00Z`).getTime() + n * 86_400_000)
  return next.toISOString().slice(0, 10)
}

function tripDayToOutlineDay(day: TripDay): RouteOutlineDay {
  return {
    index: day.index,
    date: day.date,
    type: day.type,
    overnight: {
      name: day.overnight.name,
      town: day.overnight.name,
      country: day.overnight.country,
      ...(day.overnight.campsiteSuggestion
        ? { campsiteSuggestion: day.overnight.campsiteSuggestion }
        : {}),
    },
    ...(day.drive
      ? {
          drive: {
            fromTown: day.drive.fromName,
            toTown: day.drive.toName,
            slot: day.drive.slot,
          },
        }
      : {}),
    // routeOutlineDaySchema requires a non-empty highlightReason; an existing
    // day always has a summary even when it has no highlightReason of its
    // own (e.g. a plain connecting stop), so that's a safe, truthful
    // fallback rather than fabricating a reason that was never given.
    highlightReason: day.highlightReason ?? day.summary,
  }
}

export interface ReconcileCorridorResult {
  writes: PendingWrite[]
  changes: ReconcileDayChange[]
  removedStopNames: string[]
  addedDays: { overnightName: string; date: string }[]
  totalKm: number
  avgDriveMinutesPerDay: number
  pacingWarnings: string[]
  endDateChange?: { from: string; to: string }
}

/**
 * "Lock in the new route", phase 4b (add/remove-stop reconciliation + end-date
 * extension) — generalizes phase 4a's pure-permutation reconciliation to a
 * `newStopOrder` that may also OMIT a currently-committed stop (removing it —
 * its linked day(s) are deleted outright, not merged into anything, and
 * everything later collapses forward onto the trip's start date) or INCLUDE a
 * currently-'locked' stop that has no linked days yet (a traveler-placed pin
 * or a locked rescan find — adding it): its content is generated fresh via
 * just the detail phase (buildChunkDetailPrompt/generateChunkDetail — the
 * town/location/why is already known from the corridor edit, so the
 * outline/curation phases are skipped entirely) and then resolved through
 * the SAME resolveSkeletonDay used by fresh generation and replan, passing
 * the stop's own already-known coordinates so it can't silently re-geocode
 * to a different point than the one the traveler actually placed (see
 * resolveSkeletonDay's own doc comment for why that matters) — this is also
 * what keeps the evening-slot activity-anchor logic correct here without a
 * hand-rolled shortcut (master_plan.md's own correctness-contract note).
 *
 * Because the day count can now change, the reused-date-sequence shortcut
 * 4a relied on ("reordering only permutes which content sits on which date")
 * no longer applies: dates are recomputed fresh as trip.settings.startDate +
 * i for every day in the final sequence. If that implies a different
 * settings.endDate than the trip currently has, the change is surfaced as
 * `endDateChange` in the result but never written by this function — only
 * `runReconcileCorridor` (below) touches Firestore, and only after the
 * caller has explicitly accepted it (`acceptEndDateChange`), so a traveler
 * can't have their trip silently lengthened or shortened by an edit they
 * only meant as "swap this stop for that one".
 *
 * Read-only otherwise: computes writes/diff, commits nothing.
 */
export async function computeCorridorReconciliation(
  tripId: string,
  newStopOrder: string[],
): Promise<ReconcileCorridorResult> {
  const db = getFirestore()
  const tripRef = db.collection('trips').doc(tripId)

  const tripSnap = await tripRef.get()
  if (!tripSnap.exists) {
    throw new Error(`reconcileCorridor: trip ${tripId} does not exist`)
  }
  const trip = tripSnap.data() as Trip

  const [daysSnap, corridorSnap] = await Promise.all([
    tripRef.collection('days').orderBy('date').get(),
    tripRef.collection('corridorStops').get(),
  ])

  const stopDocs = new Map(corridorSnap.docs.map((doc) => [doc.id, doc]))
  const dayDocs = new Map(daysSnap.docs.map((doc) => [doc.id, doc]))

  if (new Set(newStopOrder).size !== newStopOrder.length) {
    throw new Error('reconcileCorridor: newStopOrder contains a duplicate stop id')
  }
  for (const id of newStopOrder) {
    const doc = stopDocs.get(id)
    if (!doc) throw new Error(`reconcileCorridor: unknown corridor stop ${id}`)
    const status = (doc.data() as CorridorStop).status
    // A 'proposed' rescan find must be locked first (the same gate
    // CorridorStopCard already enforces for every other action on one) —
    // reconciling straight from a suggestion nobody has reviewed yet would
    // defeat the point of the review step.
    if (status !== 'committed' && status !== 'locked') {
      throw new Error(
        `reconcileCorridor: corridor stop ${id} must be committed or locked to be included (was ${status})`,
      )
    }
  }

  const committedStopDocs = corridorSnap.docs.filter(
    (doc) => (doc.data() as CorridorStop).status === 'committed',
  )
  const keptIds = new Set(newStopOrder)
  const removedStopDocs = committedStopDocs.filter((doc) => !keptIds.has(doc.id))

  // Every existing day must belong to exactly one committed stop — either
  // it's kept (in newStopOrder) or removed. If some day belongs to neither,
  // the corridor data is out of sync with the day list and reconciling would
  // silently lose or orphan it, so that's a hard failure rather than a
  // best-effort guess.
  const keptCommittedDocs = committedStopDocs.filter((doc) => keptIds.has(doc.id))
  const accountedDayCount =
    keptCommittedDocs.reduce(
      (sum, doc) => sum + (doc.data() as CorridorStop).linkedDayIds.length,
      0,
    ) +
    removedStopDocs.reduce(
      (sum, doc) => sum + (doc.data() as CorridorStop).linkedDayIds.length,
      0,
    )
  if (accountedDayCount !== daysSnap.size) {
    throw new Error(
      'reconcileCorridor: the committed stops\' linked days do not cover every day in the trip — a stop is missing linked days or a day belongs to no committed stop',
    )
  }

  const writes: PendingWrite[] = []

  // Removed stops: their linked day(s) are deleted outright, along with
  // each one's activities/restaurants subcollections (same delete pattern
  // generatePlan.ts's writeGeneratedDays already uses for a full rewrite).
  const removedDayIds = new Set(
    removedStopDocs.flatMap((doc) => (doc.data() as CorridorStop).linkedDayIds),
  )
  const removedDayDocs = [...removedDayIds]
    .map((id) => dayDocs.get(id))
    .filter((doc): doc is QueryDocumentSnapshot => !!doc)
  const removedDayContents = await Promise.all(
    removedDayDocs.map(async (doc) => {
      const [activities, restaurants] = await Promise.all([
        doc.ref.collection('activities').get(),
        doc.ref.collection('restaurants').get(),
      ])
      return { doc, activities, restaurants }
    }),
  )
  for (const { doc, activities, restaurants } of removedDayContents) {
    activities.docs.forEach((a) => writes.push({ op: 'delete', ref: a.ref }))
    restaurants.docs.forEach((r) => writes.push({ op: 'delete', ref: r.ref }))
    writes.push({ op: 'delete', ref: doc.ref })
  }
  for (const doc of removedStopDocs) {
    writes.push({ op: 'delete', ref: doc.ref })
  }
  const removedStopNames = removedStopDocs.map(
    (doc) => (doc.data() as CorridorStop).name,
  )

  // Each entry in newStopOrder becomes one "block": an existing committed
  // stop's linked day(s), kept in their current chronological order, or —
  // for a locked stop with no linked days yet — a brand new single day still
  // to be generated.
  type ExistingBlock = { kind: 'existing'; days: { dayId: string; day: TripDay }[] }
  type NewBlock = { kind: 'new'; stopRef: DocumentReference; stop: CorridorStop }
  const blockPlans: (ExistingBlock | NewBlock)[] = newStopOrder.map((stopId) => {
    const doc = stopDocs.get(stopId)!
    const stop = doc.data() as CorridorStop
    if (stop.status === 'locked' && stop.linkedDayIds.length === 0) {
      return { kind: 'new', stopRef: doc.ref, stop }
    }
    const days = stop.linkedDayIds
      .map((dayId) => {
        const dayDoc = dayDocs.get(dayId)
        if (!dayDoc) {
          throw new Error(
            `reconcileCorridor: corridor stop ${stopId} links to missing day ${dayId}`,
          )
        }
        return { dayId, day: dayDoc.data() as TripDay }
      })
      .sort((a, b) => a.day.index - b.day.index)
    return { kind: 'existing', days }
  })

  const flatDayCount = blockPlans.reduce(
    (sum, block) => sum + (block.kind === 'existing' ? block.days.length : 1),
    0,
  )
  const orderedDates = Array.from({ length: flatDayCount }, (_, i) =>
    addDays(trip.settings.startDate, i),
  )

  // Context for the detail-phase call on any newly-added stop: the trip's
  // current day list, in outline-day shape, gives Claude the surrounding
  // route without re-litigating it — it only ever fills in ONE new day's
  // activities/restaurants, never the route itself.
  const fullOutlineDays = daysSnap.docs.map((doc) =>
    tripDayToOutlineDay(doc.data() as TripDay),
  )
  const client = new Anthropic({ apiKey: claudeApiKey.value() })

  let previousOvernight: NamedPoint = trip.settings.startPoint
  const changes: ReconcileDayChange[] = []
  const addedDays: { overnightName: string; date: string }[] = []
  const finalDays: TripDay[] = []

  for (const block of blockPlans) {
    if (block.kind === 'existing') {
      for (const [i, { dayId, day }] of block.days.entries()) {
        const newIndex = finalDays.length
        const newDate = orderedDates[newIndex]
        let updatedDay: TripDay

        if (i === 0) {
          const leg = await computeRouteLeg(previousOvernight, day.overnight)
          updatedDay = {
            ...day,
            index: newIndex,
            date: newDate,
            type: 'drive',
            drive: {
              fromName: previousOvernight.name,
              toName: day.overnight.name,
              distanceKm: leg.distanceKm,
              durationMin: leg.durationMin,
              slot: day.drive?.slot ?? 'morning',
              ...(leg.polyline ? { polyline: leg.polyline } : {}),
            },
          }
          if (newDate !== day.date) {
            changes.push({
              dayId,
              overnightName: day.overnight.name,
              oldDate: day.date,
              newDate,
              newDistanceKm: leg.distanceKm,
              newDurationMin: leg.durationMin,
            })
          }
        } else {
          updatedDay = { ...day, index: newIndex, date: newDate }
          if (newDate !== day.date) {
            changes.push({
              dayId,
              overnightName: day.overnight.name,
              oldDate: day.date,
              newDate,
            })
          }
        }

        tripDaySchema.parse(updatedDay)
        finalDays.push(updatedDay)
        writes.push({ op: 'set', ref: dayDocs.get(dayId)!.ref, data: updatedDay })
      }
      previousOvernight = block.days[block.days.length - 1].day.overnight
    } else {
      const { stop, stopRef } = block
      if (!stop.country) {
        throw new Error(
          `reconcileCorridor: corridor stop "${stop.name}" needs a country before it can be added to the route`,
        )
      }
      const newIndex = finalDays.length
      const newDate = orderedDates[newIndex]

      // A sights-led candidate names a sight, and sleeping at one is not a
      // thing — `baseTown` is where the curation phase said to spend the
      // night while seeing it (see corridorStopSchema). Absent, the stop's
      // own name is the place, which is what every stop meant before sights
      // led the route and what a hand-dropped pin still means. The sight is
      // handed to the detail phase as the day's own `sights` entry, so the
      // day the traveler added it for actually contains it.
      const overnightTown = stop.baseTown ?? stop.name
      const syntheticDay: RouteOutlineDay = {
        index: newIndex,
        date: newDate,
        type: 'drive',
        overnight: {
          name: overnightTown,
          town: overnightTown,
          country: stop.country,
        },
        drive: {
          fromTown: previousOvernight.name,
          toTown: overnightTown,
          slot: 'evening',
        },
        sights: [stop.name],
        highlightReason: stop.why || `${stop.name}, added directly to the route.`,
      }

      const detailResponse = await generateChunkDetail(
        client,
        {
          settings: trip.settings,
          notesFreeText: trip.notes.freeText,
          outline: { days: [...fullOutlineDays, syntheticDay] },
          chunkDays: [syntheticDay],
        },
        { tripId, callType: 'reconcileDetail' },
      )
      const detail = detailResponse.days[0]
      if (!detail) {
        throw new Error(
          `reconcileCorridor: Claude never returned detail for the added stop "${stop.name}"`,
        )
      }

      const { generated, nextLocation } = await resolveSkeletonDay(
        {
          index: newIndex,
          date: newDate,
          type: 'drive',
          overnight: syntheticDay.overnight,
          drive: syntheticDay.drive,
          summary: detail.summary,
          extraTimeReason: detail.extraTimeReason,
          highlightReason: syntheticDay.highlightReason,
          activities: detail.activities,
          restaurants: detail.restaurants,
        },
        previousOvernight,
        { lat: stop.lat, lng: stop.lng, country: stop.country },
      )

      const newDay = tripDaySchema.parse(generated.day)
      const newDayRef = tripRef.collection('days').doc()
      writes.push({ op: 'set', ref: newDayRef, data: newDay })
      for (const activity of generated.activities) {
        writes.push({
          op: 'set',
          ref: newDayRef.collection('activities').doc(),
          data: activity,
        })
      }
      for (const restaurant of generated.restaurants) {
        writes.push({
          op: 'set',
          ref: newDayRef.collection('restaurants').doc(),
          data: restaurant,
        })
      }
      writes.push({
        op: 'set',
        ref: stopRef,
        data: corridorStopSchema.parse({
          ...stop,
          status: 'committed',
          linkedDayIds: [newDayRef.id],
        }),
      })

      finalDays.push(newDay)
      addedDays.push({ overnightName: newDay.overnight.name, date: newDay.date })
      previousOvernight = nextLocation
    }
  }

  const violation = validatePacing(finalDays, trip.settings.maxDriveHoursPerDay)
  if (violation) {
    throw new Error(`reconcileCorridor: pacing validation failed: ${violation.reason}`)
  }

  const driveDays = finalDays.filter((day) => day.drive)
  const totalKm = driveDays.reduce(
    (sum, day) => sum + (day.drive?.distanceKm ?? 0),
    0,
  )
  const avgDriveMinutesPerDay = driveDays.length
    ? driveDays.reduce((sum, day) => sum + (day.drive?.durationMin ?? 0), 0) /
      driveDays.length
    : 0

  const impliedEndDate = orderedDates[orderedDates.length - 1]
  const endDateChange =
    impliedEndDate !== trip.settings.endDate
      ? { from: trip.settings.endDate, to: impliedEndDate }
      : undefined

  return {
    writes,
    changes,
    removedStopNames,
    addedDays,
    totalKm,
    avgDriveMinutesPerDay,
    // Advisory, not a gate — see pacingWarnings(). Reordering or dropping a
    // stop is exactly the kind of edit that can leave a day with nowhere to
    // go, so it's recomputed here rather than left over from generation.
    pacingWarnings: pacingWarnings(finalDays),
    ...(endDateChange ? { endDateChange } : {}),
  }
}

/**
 * Commits the reconciliation computed above and updates planMeta/settings to
 * match. Refuses to write anything if the reconciliation implies a different
 * settings.endDate and the caller hasn't explicitly accepted that — a
 * traveler confirming "move this stop" or "drop this stop" should never
 * silently change their trip's return date as a side effect; the diff screen
 * surfaces `endDateChange` and requires ticking an explicit accept before
 * `acceptEndDateChange` is set true here (mirrors insertRestDay.ts, which DOES
 * always extend endDate — but that's already an explicit, single-purpose "add
 * one more day" action, not a side effect of an edit meant as something else).
 */
export async function runReconcileCorridor(
  tripId: string,
  newStopOrder: string[],
  acceptEndDateChange = false,
): Promise<ReconcileCorridorResult> {
  const result = await computeCorridorReconciliation(tripId, newStopOrder)

  if (result.endDateChange && !acceptEndDateChange) {
    throw new Error(
      `reconcileCorridor: this change would move the trip's end date from ${result.endDateChange.from} to ${result.endDateChange.to} — accept the end-date change to proceed`,
    )
  }

  const db = getFirestore()
  await commitInChunks(db, result.writes)
  const tripRef = db.collection('trips').doc(tripId)
  await tripRef.update({
    ...(result.endDateChange ? { 'settings.endDate': result.endDateChange.to } : {}),
    'planMeta.status': 'ready',
    'planMeta.totalKm': result.totalKm,
    'planMeta.avgDriveMinutesPerDay': result.avgDriveMinutesPerDay,
    'planMeta.pacingWarnings':
      result.pacingWarnings.length > 0
        ? result.pacingWarnings
        : FieldValue.delete(),
  })

  return result
}
