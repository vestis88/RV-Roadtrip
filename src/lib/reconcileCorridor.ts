import { addDoc, collection, serverTimestamp } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import type { ReconcileDayChange } from '@rv/shared'
import { db, functions } from './firebase'

export async function previewReconcileCorridor(
  tripId: string,
  newStopOrder: string[],
): Promise<ReconcileDayChange[]> {
  const call = httpsCallable<
    { tripId: string; newStopOrder: string[] },
    { changes: ReconcileDayChange[] }
  >(functions, 'previewReconcileCorridor')
  const result = await call({ tripId, newStopOrder })
  return result.data.changes
}

/**
 * Rides the normal planRequests flow (like replan/insertRestDay) rather than
 * writing day docs from the client — it mutates every reordered day's date
 * and drive leg, so it needs the same "one plan operation per trip at a
 * time" guard those already get.
 */
export async function submitReconcileCorridor(
  tripId: string,
  newStopOrder: string[],
): Promise<void> {
  await addDoc(collection(db, 'planRequests'), {
    tripId,
    kind: 'reconcileCorridor',
    reconcileCorridorContext: { newStopOrder },
    status: 'pending',
    createdAt: serverTimestamp(),
  })
}
