import { getFirestore, type DocumentReference } from 'firebase-admin/firestore'
import {
  tripDaySchema,
  type CorridorStop,
  type NamedPoint,
  type ReconcileDayChange,
  type Trip,
  type TripDay,
} from '@rv/shared'
import { validatePacing } from './pacingValidator.js'
import { computeRouteLeg } from './routesApi.js'
import { commitInChunks, type PendingWrite } from './firestoreBatch.js'

/**
 * "Lock in the new route", phase 4a (reorder/date-shift only): reorders a
 * trip's committed corridor stops without touching which stops exist —
 * adding or removing one is phase 4b's job, not this function's, which is
 * why it rejects anything but a pure permutation of the current set.
 *
 * There is deliberately no drag-and-drop trigger for this: HighlightsReviewPanel
 * tried drag-and-drop for its own re-ranking and it never worked reliably on
 * a touch device (see its own e2e test asserting no [draggable] affordance
 * survives) — the traveler-facing side of this reorders via plain up/down
 * buttons on a list instead (ReorderCorridorPanel.tsx), same lesson applied.
 *
 * A "stop" can cover more than one TripDay (a rest day shares its previous
 * day's overnight) — those days move as one block, keeping their internal
 * relative order, onto the SAME calendar dates the trip already spans: this
 * only permutes which content occupies which date, it never changes the
 * trip's length. Only a block's first day ever carries a drive leg (the
 * arrival at that stop) — recomputed fresh via computeRouteLeg against
 * whatever new stop now precedes it, since that's exactly what moved. Later
 * days in the same block (e.g. a rest day) keep their existing content
 * untouched apart from date/index.
 *
 * Read-only: builds the day rewrites and the traveler-facing diff, but
 * commits nothing — callers decide whether this is a dry-run preview
 * (previewReconcileCorridorCallable.ts) or the real thing
 * (runReconcileCorridor, dispatched through generatePlan.ts's planRequests
 * trigger so it shares the same one-operation-per-trip busy guard
 * insertRestDay/replan already rely on — this mutates real day data, unlike
 * the purely additive rescanCorridor).
 */
export async function computeCorridorReconciliation(
  tripId: string,
  newStopOrder: string[],
): Promise<{
  writes: PendingWrite[]
  changes: ReconcileDayChange[]
  totalKm: number
  avgDriveMinutesPerDay: number
}> {
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

  const committedStopDocs = corridorSnap.docs.filter(
    (doc) => (doc.data() as CorridorStop).status === 'committed',
  )
  const currentIds = new Set(committedStopDocs.map((doc) => doc.id))
  const newIds = new Set(newStopOrder)
  const isPurePermutation =
    currentIds.size === newIds.size &&
    newStopOrder.length === newIds.size &&
    [...currentIds].every((id) => newIds.has(id))
  if (!isPurePermutation) {
    throw new Error(
      'reconcileCorridor: newStopOrder must be exactly a permutation of the trip\'s currently committed corridor stops',
    )
  }

  const dayById = new Map(
    daysSnap.docs.map((doc) => [doc.id, doc.data() as TripDay]),
  )
  const dayRefById = new Map(
    daysSnap.docs.map((doc): [string, DocumentReference] => [doc.id, doc.ref]),
  )
  const stopById = new Map(
    committedStopDocs.map((doc) => [doc.id, doc.data() as CorridorStop]),
  )

  // Each block = one corridor stop's linked day(s), kept in their existing
  // chronological order — reordering moves the block as a unit.
  const blocks = newStopOrder.map((stopId) => {
    const stop = stopById.get(stopId)
    if (!stop) throw new Error(`reconcileCorridor: unknown corridor stop ${stopId}`)
    const blockDays = stop.linkedDayIds
      .map((dayId) => {
        const day = dayById.get(dayId)
        if (!day) {
          throw new Error(
            `reconcileCorridor: corridor stop ${stopId} links to missing day ${dayId}`,
          )
        }
        return { dayId, day }
      })
      .sort((a, b) => a.day.index - b.day.index)
    return blockDays
  })

  // Reordering only ever permutes which content sits on which date — the
  // trip's own existing sorted date sequence is reused verbatim.
  const orderedDates = daysSnap.docs.map((doc) => (doc.data() as TripDay).date)
  const flatDayCount = blocks.reduce((sum, block) => sum + block.length, 0)
  if (flatDayCount !== orderedDates.length) {
    throw new Error(
      'reconcileCorridor: the committed stops\' linked days do not cover every day in the trip — a stop is missing linked days or a day belongs to no committed stop',
    )
  }

  let previousOvernight: NamedPoint = trip.settings.startPoint
  const writes: PendingWrite[] = []
  const changes: ReconcileDayChange[] = []
  const finalDays: TripDay[] = []

  for (const block of blocks) {
    for (const [i, { dayId, day }] of block.entries()) {
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
        // A later day in the same block (e.g. a rest day) never drives —
        // only its date/index move, its content stays untouched.
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
      writes.push({ op: 'set', ref: dayRefById.get(dayId)!, data: updatedDay })
    }
    previousOvernight = block[block.length - 1].day.overnight
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

  return { writes, changes, totalKm, avgDriveMinutesPerDay }
}

/** Commits the reconciliation computed above and updates planMeta to match. */
export async function runReconcileCorridor(
  tripId: string,
  newStopOrder: string[],
): Promise<ReconcileDayChange[]> {
  const { writes, changes, totalKm, avgDriveMinutesPerDay } =
    await computeCorridorReconciliation(tripId, newStopOrder)

  const db = getFirestore()
  await commitInChunks(db, writes)
  await db.collection('trips').doc(tripId).update({
    'planMeta.status': 'ready',
    'planMeta.totalKm': totalKm,
    'planMeta.avgDriveMinutesPerDay': avgDriveMinutesPerDay,
  })

  return changes
}
