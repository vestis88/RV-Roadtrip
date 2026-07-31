import { addDoc, collection, serverTimestamp } from 'firebase/firestore'
import { db } from './firebase'

/**
 * Both real-generation entry points (a fresh 'full' plan, and explore
 * mode's 'fromExploreCandidates' commit step) go through the same
 * planRequests trigger generatePlan.ts already handles — this is the one
 * place that writes one, so ConfirmGenerateDialog has a single call site to
 * sit in front of regardless of which kind is firing.
 */
export async function submitPlanRequest(
  tripId: string,
  kind: 'full' | 'fromExploreCandidates',
): Promise<void> {
  await addDoc(collection(db, 'planRequests'), {
    tripId,
    kind,
    status: 'pending',
    createdAt: serverTimestamp(),
  })
}
