import { addDoc, collection, doc, getDocs, updateDoc } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import type { Activity, ActivityTimeOfDay, Meal, Restaurant } from '@rv/shared'
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

/** Activities only — see PlaceCard's own comment on why this is Select-time,
 * not generation-time, and why it's meaningless before the item is selected. */
export async function setActivityTimeOfDay(
  tripId: string,
  dayId: string,
  placeId: string,
  timeOfDay: ActivityTimeOfDay,
) {
  await updateDoc(
    doc(db, 'trips', tripId, 'days', dayId, 'activities', placeId),
    { timeOfDay },
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
  // status change itself. Only ever returned by selectAndRequeue — skip
  // always attempts a replacement.
  | 'no_action'
  // A generation-time reserve item (or one left over from an earlier
  // research call, see below) was waiting in the wings and got promoted in
  // place, instantly, no round-trip.
  | 'requeued'
  // No reserve left either — researchMoreAlternatives found and added fresh
  // options.
  | 'researched'
  // No reserve left, and research came back empty — genuinely nothing more
  // nearby.
  | 'exhausted'

// The whole subcollection is fetched and filtered in memory rather than
// queried with Firestore `where` clauses: a day's activities/restaurants are
// a handful of docs at most, and avoiding composite-index requirements (a
// status + reserve equality query would need one) is worth more here than
// the query would save.
async function fetchScopedDocs(
  tripId: string,
  dayId: string,
  kind: PlaceKind,
  meal?: Meal,
) {
  const collRef = collection(db, 'trips', tripId, 'days', dayId, SUBCOLLECTION[kind])
  const snap = await getDocs(collRef)
  return snap.docs.filter((d) => {
    const data = d.data() as Activity | Restaurant
    return kind === 'activity' || (data as Restaurant).meal === meal
  })
}

/**
 * Promotes a hidden reserve item (see activitySchema's own comment) if one
 * exists, or calls researchMoreAlternatives for fresh ones once reserve
 * itself runs out too. `visibleCount` caps how many of a fresh research
 * batch become immediately visible — the rest are written back as reserve,
 * so a run of several single-item requests (skipAndRequeue) can keep being
 * served instantly instead of hitting Places on every one.
 */
async function promoteReserveOrResearch(
  tripId: string,
  dayId: string,
  kind: PlaceKind,
  meal: Meal | undefined,
  visibleCount?: number,
): Promise<RequeueResult> {
  const scoped = await fetchScopedDocs(tripId, dayId, kind, meal)
  const reserveDoc = scoped.find((d) => (d.data() as Activity | Restaurant).reserve)
  if (reserveDoc) {
    await updateDoc(reserveDoc.ref, { reserve: false })
    return 'requeued'
  }

  const researchMore = httpsCallable<
    { tripId: string; dayId: string; kind: PlaceKind; meal?: Meal; visibleCount?: number },
    { added: number }
  >(functions, 'researchMoreAlternatives')
  const result = await researchMore({ tripId, dayId, kind, meal, visibleCount })
  return result.data.added > 0 ? 'researched' : 'exhausted'
}

/**
 * Dismiss-and-requeue (implemented 2026-07-30, split into per-skip and
 * whole-pool cascades 2026-07-30): skipping means "not interested in this
 * one, show me something else" — every skip tries to bring in exactly one
 * replacement (promoting reserve, or researching one), regardless of how
 * many other suggested items remain in the scope.
 */
export async function skipAndRequeue(
  tripId: string,
  dayId: string,
  kind: PlaceKind,
  placeId: string,
  meal?: Meal,
): Promise<RequeueResult> {
  await markSkipped(tripId, dayId, kind, placeId)
  return promoteReserveOrResearch(tripId, dayId, kind, meal, 1)
}

/**
 * Selecting means "keeping this one" — several items can be selected at
 * once (there's no "only one selected" rule anywhere in this app), so this
 * only refills once the whole scope's live `'suggested'` pool is drained
 * ("all 5 selected", "1 selected, the other 4 skipped", etc. are all the
 * same "nothing left to actually browse" state). Reverting a selection back
 * to suggested (markSuggested) only grows the pool, so it never needs this
 * check.
 */
export async function selectAndRequeue(
  tripId: string,
  dayId: string,
  kind: PlaceKind,
  placeId: string,
  meal?: Meal,
): Promise<RequeueResult> {
  await markSelected(tripId, dayId, kind, placeId)
  const scoped = await fetchScopedDocs(tripId, dayId, kind, meal)
  const liveSuggested = scoped.filter((d) => {
    const data = d.data() as Activity | Restaurant
    return data.status === 'suggested' && !data.reserve
  })
  if (liveSuggested.length > 0) return 'no_action'
  return promoteReserveOrResearch(tripId, dayId, kind, meal)
}
