import { deleteDoc, doc, updateDoc } from 'firebase/firestore'
import type { CorridorStopStatus } from '@rv/shared'
import { db } from './firebase'

export async function setCorridorStopStatus(
  tripId: string,
  stopId: string,
  status: CorridorStopStatus,
) {
  await updateDoc(doc(db, 'trips', tripId, 'corridorStops', stopId), { status })
}

export async function deleteCorridorStop(tripId: string, stopId: string) {
  await deleteDoc(doc(db, 'trips', tripId, 'corridorStops', stopId))
}

/**
 * "Not interested" (2026-08-13). Looks identical to the traveler — the card
 * disappears — but leaves a tombstone instead of deleting the doc, because
 * "Find more stops" now merges into the existing corridor rather than
 * replacing it. A deleted stop is indistinguishable from one that was never
 * suggested, so the next refresh would cheerfully propose it again; a
 * `rejected` one is remembered and skipped. Nothing renders rejected stops:
 * the explore list, the route backbone and the generation seed all read
 * `candidate`/`locked` only.
 */
export async function rejectCorridorStop(tripId: string, stopId: string) {
  await setCorridorStopStatus(tripId, stopId, 'rejected')
}
