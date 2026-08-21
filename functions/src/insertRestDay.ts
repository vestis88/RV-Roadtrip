import { FieldValue, getFirestore, type DocumentData } from 'firebase-admin/firestore'
import {
  activitySchema,
  corridorStopSchema,
  restaurantSchema,
  tripDaySchema,
  type CorridorStop,
  type Trip,
  type TripDay,
} from '@rv/shared'
import { commitInChunks, type PendingWrite } from './firestoreBatch.js'

/**
 * Adds one calendar day to a `YYYY-MM-DD` date string.
 *
 * Parsed explicitly as UTC midnight: `new Date('2026-07-10')` is already
 * UTC, but `new Date('2026-07-10T00:00:00')` is local, and formatting via
 * local getters west of Greenwich would hand back the day before. Doing
 * both ends in UTC keeps this correct regardless of where the function runs.
 */
export function addOneDay(date: string): string {
  const next = new Date(new Date(`${date}T00:00:00Z`).getTime() + 86_400_000)
  return next.toISOString().slice(0, 10)
}

/** Strips the fields a copied suggestion must not inherit. */
function asFreshSuggestion(data: DocumentData): DocumentData {
  const copy: DocumentData = { ...data, status: 'suggested' }
  delete copy.doneAt
  delete copy.diaryNote
  return copy
}

/**
 * Inserts one extra rest day immediately after `afterDayId`: the traveler
 * stays where they are for one more night, and every later day shifts one
 * calendar day back to make room (the trip's endDate grows by a day too).
 *
 * Purely mechanical — no Claude/Places/Routes call. Nothing about the
 * existing days' content changes; only their `date` and `index`.
 *
 * Day docs have stable (auto-generated) IDs, not date-keyed ones, so
 * "shift a day" is just a field update on its existing doc — no copying its
 * activities/restaurants to a new parent, no delete-before-write ordering to
 * worry about.
 *
 * Everything is read and validated before the first write, and the writes
 * are chunked across multiple batches (see commitInChunks) so a long trip's
 * shifted tail doesn't exceed Firestore's 500-op batch limit.
 */
export async function runInsertRestDay(
  tripId: string,
  afterDayId: string,
): Promise<void> {
  const db = getFirestore()
  const tripRef = db.collection('trips').doc(tripId)

  const tripSnap = await tripRef.get()
  if (!tripSnap.exists) {
    throw new Error(`insertRestDay: trip ${tripId} does not exist`)
  }
  const trip = tripSnap.data() as Trip

  const daysSnap = await tripRef.collection('days').orderBy('date').get()
  const afterDoc = daysSnap.docs.find((doc) => doc.id === afterDayId)
  if (!afterDoc) {
    throw new Error(
      `insertRestDay: day ${afterDayId} does not exist on trip ${tripId}`,
    )
  }
  const afterDay = afterDoc.data() as TripDay

  const newRestDate = addOneDay(afterDay.date)

  // Read everything up front — the day we're copying suggestions from, and
  // (below) every day that has to shift. Nothing is written until all of it
  // is in hand and validated.
  const [afterActivitiesSnap, afterRestaurantsSnap] = await Promise.all([
    afterDoc.ref.collection('activities').get(),
    afterDoc.ref.collection('restaurants').get(),
  ])

  const shiftedDocs = daysSnap.docs.filter(
    (doc) => (doc.data() as TripDay).date > afterDay.date,
  )

  const writes: PendingWrite[] = []
  const shiftedDays: TripDay[] = []

  // Order doesn't matter any more — each shift is a field update on the
  // day's own existing doc, not a move to a new one, so there's no ID
  // collision to sequence around.
  for (const doc of shiftedDocs) {
    const day = doc.data() as TripDay
    const movedDay = {
      ...day,
      date: addOneDay(day.date),
      index: day.index + 1,
    }
    shiftedDays.push(movedDay)
    writes.push({ op: 'set', ref: doc.ref, data: movedDay })
  }

  const newDay = tripDaySchema.parse({
    index: afterDay.index + 1,
    date: newRestDate,
    type: 'rest',
    // Verbatim, including a free night's type/freeCampingRule: staying put is
    // the whole request, so this must not quietly relocate the traveler to a
    // campsite the way the off-grid rule would have (pickDefaultOvernight
    // gives rest days facilities). A "refresh overnight options" run applies
    // that rule to the extended stay if they want it applied.
    overnight: afterDay.overnight,
    summary: `An extra day in ${afterDay.overnight.name} — no driving today.`,
  })
  const newDayRef = tripRef.collection('days').doc()
  writes.push({ op: 'set', ref: newDayRef, data: newDay })

  // The suggestions for the day being extended are already vetted and
  // town-relevant, so they make a good starting point for the extra day —
  // but only as suggestions: the new day has had none of its own choices
  // made, so it must not inherit selections, completions or diary notes.
  for (const activity of afterActivitiesSnap.docs) {
    const copy = activitySchema.parse(asFreshSuggestion(activity.data()))
    writes.push({
      op: 'set',
      ref: newDayRef.collection('activities').doc(),
      data: copy,
    })
  }
  for (const restaurant of afterRestaurantsSnap.docs) {
    const copy = restaurantSchema.parse(asFreshSuggestion(restaurant.data()))
    writes.push({
      op: 'set',
      ref: newDayRef.collection('restaurants').doc(),
      data: copy,
    })
  }

  // The new rest day shares afterDay's overnight verbatim, so it belongs to
  // whatever corridor stop afterDayId already belongs to. A trip created
  // before corridor stops existed has none yet — skip silently and let it
  // catch up lazily on its next full regen/replan.
  const corridorSnap = await tripRef.collection('corridorStops').get()
  const afterStopDoc = corridorSnap.docs.find((doc) =>
    (doc.data() as CorridorStop).linkedDayIds.includes(afterDayId),
  )
  if (afterStopDoc) {
    const stop = afterStopDoc.data() as CorridorStop
    writes.push({
      op: 'set',
      ref: afterStopDoc.ref,
      data: corridorStopSchema.parse({
        ...stop,
        linkedDayIds: [...stop.linkedDayIds, newDayRef.id],
      }),
    })
  }

  await commitInChunks(db, writes)

  // Recomputed over the resulting day list exactly as replanTrip does, even
  // though inserting a rest day can't change either number (no drive leg was
  // added or removed) — every mutation maintaining planMeta the same way is
  // worth more than skipping a cheap reduce.
  const unshiftedDays = daysSnap.docs
    .map((doc) => doc.data() as TripDay)
    .filter((day) => day.date <= afterDay.date)
  const allDays: TripDay[] = [...unshiftedDays, newDay, ...shiftedDays]
  const driveDays = allDays.filter((day) => day.drive)
  const totalKm = driveDays.reduce(
    (sum, day) => sum + (day.drive?.distanceKm ?? 0),
    0,
  )
  const avgDriveMinutesPerDay = driveDays.length
    ? driveDays.reduce((sum, day) => sum + (day.drive?.durationMin ?? 0), 0) /
      driveDays.length
    : 0

  await tripRef.update({
    // The trip really is one calendar day longer now.
    'settings.endDate': addOneDay(trip.settings.endDate),
    'planMeta.status': 'ready',
    // Whatever made it stale has now been planned for — see
    // planMeta.staleSettings.
    'planMeta.staleSettings': FieldValue.delete(),
    'planMeta.totalKm': totalKm,
    'planMeta.avgDriveMinutesPerDay': avgDriveMinutesPerDay,
  })
}
