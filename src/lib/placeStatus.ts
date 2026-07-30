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

export type RequeueResult =
  // Other live options remain in this scope — nothing needed beyond the
  // status change itself.
  | 'no_action'
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
 * Dismiss-and-requeue (implemented 2026-07-30, generalized to selecting
 * 2026-07-30): a scope (a day's activities, or one meal's restaurants) needs
 * at least one live `'suggested'` option to still be worth browsing. Both
 * skipping AND selecting drain that pool the same way — several items can be
 * selected (there's no "only one selected" rule anywhere in this app), so
 * "all 5 selected", "all 5 skipped", and "1 selected, the other 4 skipped"
 * are exactly the same "nothing left to actually choose from" state, however
 * the pool got there. Whichever action (`skipAndRequeue`/`selectAndRequeue`
 * below) empties it triggers the same refill: promote a hidden reserve item
 * (see activitySchema's own comment) if one exists, or call
 * researchMoreAlternatives for fresh ones once reserve itself runs out too —
 * which can cascade one promotion at a time across several consecutive
 * selects/skips before an actual research call is ever needed.
 *
 * The whole subcollection is fetched and filtered in memory rather than
 * queried with Firestore `where` clauses: a day's activities/restaurants are
 * a handful of docs at most, and avoiding composite-index requirements (a
 * status + reserve equality query would need one) is worth more here than
 * the query would save.
 */
async function refillIfExhausted(
  tripId: string,
  dayId: string,
  kind: PlaceKind,
  meal?: Meal,
): Promise<RequeueResult> {
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
  if (liveSuggested.length > 0) return 'no_action'

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

export async function skipAndRequeue(
  tripId: string,
  dayId: string,
  kind: PlaceKind,
  placeId: string,
  meal?: Meal,
): Promise<RequeueResult> {
  await markSkipped(tripId, dayId, kind, placeId)
  return refillIfExhausted(tripId, dayId, kind, meal)
}

/** Same cascade as skipAndRequeue, triggered by selecting instead — see its
 * own doc comment (refillIfExhausted) for why both need it. Only call this
 * for the suggested→selected transition; reverting a selection (markSuggested)
 * grows the pool, so it never needs a refill check. */
export async function selectAndRequeue(
  tripId: string,
  dayId: string,
  kind: PlaceKind,
  placeId: string,
  meal?: Meal,
): Promise<RequeueResult> {
  await markSelected(tripId, dayId, kind, placeId)
  return refillIfExhausted(tripId, dayId, kind, meal)
}
