import { addDoc, collection, serverTimestamp } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import type { ReconcileDayChange } from '@rv/shared'
import { db, functions } from './firebase'
import { LONG_CALLABLE_TIMEOUT_MS } from './callableTimeouts'

export interface ReconcileCorridorPreview {
  changes: ReconcileDayChange[]
  removedStopNames: string[]
  addedDays: { overnightName: string; date: string }[]
  endDateChange?: { from: string; to: string }
}

export async function previewReconcileCorridor(
  tripId: string,
  newStopOrder: string[],
): Promise<ReconcileCorridorPreview> {
  const call = httpsCallable<
    { tripId: string; newStopOrder: string[] },
    ReconcileCorridorPreview
  >(functions, 'previewReconcileCorridor', { timeout: LONG_CALLABLE_TIMEOUT_MS })
  const result = await call({ tripId, newStopOrder })
  return result.data
}

/**
 * Rides the normal planRequests flow (like replan/insertRestDay) rather than
 * writing day docs from the client — it mutates every reordered/added/removed
 * day's date and drive leg, so it needs the same "one plan operation per trip
 * at a time" guard those already get. `acceptEndDateChange` must be true
 * whenever the preview reported an `endDateChange` — the traveler has to see
 * and accept that before it's applied, not have it happen as a silent side
 * effect of reordering/adding/removing a stop (see corridorReconciliation.ts's
 * own doc comment on the server side).
 */
export async function submitReconcileCorridor(
  tripId: string,
  newStopOrder: string[],
  acceptEndDateChange = false,
): Promise<void> {
  await addDoc(collection(db, 'planRequests'), {
    tripId,
    kind: 'reconcileCorridor',
    reconcileCorridorContext: { newStopOrder, acceptEndDateChange },
    status: 'pending',
    createdAt: serverTimestamp(),
  })
}
