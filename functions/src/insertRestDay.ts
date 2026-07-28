import { getFirestore, type DocumentData } from 'firebase-admin/firestore'
import {
  activitySchema,
  restaurantSchema,
  tripDaySchema,
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
 * Because a day's Firestore doc ID *is* its date, "move a day" means copy
 * the day doc plus its activities/restaurants to the new date's doc and
 * delete the originals — there is no atomic rename. Days are processed
 * latest-first so that a day's old doc is always deleted before the day
 * behind it is written into that same ID.
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

  // Read everything up front: the day we're copying suggestions from, and
  // every day that has to shift (with its subcollections). Nothing is
  // written until all of it is in hand and validated.
  const [afterActivitiesSnap, afterRestaurantsSnap] = await Promise.all([
    afterDoc.ref.collection('activities').get(),
    afterDoc.ref.collection('restaurants').get(),
  ])

  const shiftedDocs = daysSnap.docs.filter(
    (doc) => (doc.data() as TripDay).date > afterDay.date,
  )
  const shiftedContents = await Promise.all(
    shiftedDocs.map(async (doc) => {
      const [activities, restaurants] = await Promise.all([
        doc.ref.collection('activities').get(),
        doc.ref.collection('restaurants').get(),
      ])
      return { doc, activities, restaurants }
    }),
  )

  const writes: PendingWrite[] = []
  const shiftedDays: TripDay[] = []

  // Latest-dated day first — see the doc comment above.
  for (const { doc, activities, restaurants } of [...shiftedContents].reverse()) {
    const day = doc.data() as TripDay
    const movedDay = {
      ...day,
      date: addOneDay(day.date),
      index: day.index + 1,
    }
    shiftedDays.push(movedDay)

    const newDayRef = tripRef.collection('days').doc(movedDay.date)
    writes.push({ op: 'set', ref: newDayRef, data: movedDay })
    for (const activity of activities.docs) {
      writes.push({
        op: 'set',
        ref: newDayRef.collection('activities').doc(activity.id),
        data: activity.data(),
      })
      writes.push({ op: 'delete', ref: activity.ref })
    }
    for (const restaurant of restaurants.docs) {
      writes.push({
        op: 'set',
        ref: newDayRef.collection('restaurants').doc(restaurant.id),
        data: restaurant.data(),
      })
      writes.push({ op: 'delete', ref: restaurant.ref })
    }
    writes.push({ op: 'delete', ref: doc.ref })
  }

  // The inserted day itself, written last: its date is the old date of the
  // day that used to follow afterDay, which by now has been moved away and
  // deleted.
  const newDay = tripDaySchema.parse({
    index: afterDay.index + 1,
    date: newRestDate,
    type: 'rest',
    overnight: afterDay.overnight,
    summary: `An extra day in ${afterDay.overnight.name} — no driving today.`,
  })
  const newDayRef = tripRef.collection('days').doc(newRestDate)
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
    'planMeta.totalKm': totalKm,
    'planMeta.avgDriveMinutesPerDay': avgDriveMinutesPerDay,
  })
}
