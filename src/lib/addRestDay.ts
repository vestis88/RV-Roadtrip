import { addDoc, collection, serverTimestamp } from 'firebase/firestore'
import { db } from './firebase'

/**
 * Asks for one extra rest day right after `afterDayId`: the traveler stays
 * put a day longer and every later day shifts one calendar day back.
 *
 * Goes through planRequests (like replan/full) rather than writing the day
 * docs from the client — it touches every day from the insertion point on,
 * so it needs the same "one plan operation per trip at a time" guard the
 * generatePlan trigger applies.
 */
export async function submitInsertRestDay(
  tripId: string,
  afterDayId: string,
): Promise<void> {
  await addDoc(collection(db, 'planRequests'), {
    tripId,
    kind: 'insertRestDay',
    insertRestDayContext: { afterDayId },
    status: 'pending',
    createdAt: serverTimestamp(),
  })
}
