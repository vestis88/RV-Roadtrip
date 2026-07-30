import { addDoc, collection, doc, getDocs, updateDoc } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import type { Activity, Meal, Restaurant } from '@rv/shared'
import { db, functions } from './firebase'

export type PlaceKind = 'activity' | 'restaurant'

const SUBCOLLECTION: Record<PlaceKind, string> = {
  activity: 'activities',
  restaurant: 'restaurants',
}

export async function markSelected(
  tripId: string,
  dayId: string,
  kind: PlaceKind,
  placeId: string,
) {
  await updateDoc(
    doc(db, 'trips', tripId, 'days', dayId, SUBCOLLECTION[kind], placeId),
    { status: 'selected' },
  )
}

/** Reverts a selected item back to the neutral default — "unselect". */
export async function markSuggested(
  tripId: string,
  dayId: string,
  kind: PlaceKind,
  placeId: string,
) {
  await updateDoc(
    doc(db, 'trips', tripId, 'days', dayId, SUBCOLLECTION[kind], placeId),
    { status: 'suggested' },
  )
}

export async function markSkipped(
  tripId: string,
  dayId: string,
  kind: PlaceKind,
  placeId: string,
) {
  await updateDoc(
    doc(db, 'trips', tripId, 'days', dayId, SUBCOLLECTION[kind], placeId),
    { status: 'skipped' },
  )
}

export async function markDone(
  tripId: string,
  dayId: string,
  kind: PlaceKind,
  placeId: string,
  date: string,
  note: string,
) {
  const now = new Date().toISOString()
  const refPath = `trips/${tripId}/days/${dayId}/${SUBCOLLECTION[kind]}/${placeId}`

  await updateDoc(doc(db, refPath), {
    status: 'done',
    doneAt: now,
    ...(note ? { diaryNote: note } : {}),
  })

  await addDoc(collection(db, 'trips', tripId, 'log'), {
    date,
    refType: kind,
    refPath,
    ...(note ? { note } : {}),
    createdAt: now,
  })
}

export type SkipAndRequeueResult =
  // Other displayed options remain — nothing needed beyond the skip itself.
  | 'skipped'
  // A generation-time reserve item was waiting in the wings and got
  // promoted in place, instantly, no round-trip.
  | 'requeued'
  // No reserve left either — researchMoreAlternatives found and added fresh
  // options.
  | 'researched'
  // No reserve left, and research came back empty — genuinely nothing more
  // nearby.
  | 'exhausted'

/**
 * Dismiss-and-requeue (implemented 2026-07-30): skipping used to just leave
 * a gap — the pool of displayed options only ever shrank. Now, whenever a
 * skip would leave a scope (a day's activities, or one meal's restaurants)
 * with zero live options — every one skipped, or one selected and every
 * other skipped, the same "nothing left to actually choose from" state —
 * this promotes a hidden reserve item (see activitySchema's own comment) if
 * one exists, or calls researchMoreAlternatives for fresh ones if not.
 *
 * The whole subcollection is fetched and filtered in memory rather than
 * queried with Firestore `where` clauses: a day's activities/restaurants are
 * a handful of docs at most, and avoiding composite-index requirements (a
 * status + reserve equality query would need one) is worth more here than
 * the query would save.
 */
export async function skipAndRequeue(
  tripId: string,
  dayId: string,
  kind: PlaceKind,
  placeId: string,
  meal?: Meal,
): Promise<SkipAndRequeueResult> {
  await markSkipped(tripId, dayId, kind, placeId)

  const collRef = collection(db, 'trips', tripId, 'days', dayId, SUBCOLLECTION[kind])
  const snap = await getDocs(collRef)
  const scoped = snap.docs.filter((d) => {
    const data = d.data() as Activity | Restaurant
    return kind === 'activity' || (data as Restaurant).meal === meal
  })

  const liveSuggested = scoped.filter((d) => {
    const data = d.data() as Activity | Restaurant
    return data.status === 'suggested' && !data.reserve
  })
  if (liveSuggested.length > 0) return 'skipped'

  const reserveDoc = scoped.find((d) => (d.data() as Activity | Restaurant).reserve)
  if (reserveDoc) {
    await updateDoc(reserveDoc.ref, { reserve: false })
    return 'requeued'
  }

  const researchMore = httpsCallable<
    { tripId: string; dayId: string; kind: PlaceKind; meal?: Meal },
    { added: number }
  >(functions, 'researchMoreAlternatives')
  const result = await researchMore({ tripId, dayId, kind, meal })
  return result.data.added > 0 ? 'researched' : 'exhausted'
}
