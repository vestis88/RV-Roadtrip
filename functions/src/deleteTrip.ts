import { getFirestore } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/https'
import type { Trip } from '@rv/shared'
import { requireAccess } from './accessControl.js'
import { commitInChunks, type PendingWrite } from './firestoreBatch.js'
import { SHARE_TOKENS_COLLECTION } from './shareTokens.js'

/**
 * Deletes a trip entirely: every day/activity/restaurant/corridorStop/
 * country/log entry, its share code, and the reverse-index entry
 * (`users/{uid}/trips/{tripId}`) for every member, not just the caller —
 * a shared trip deleted by one traveler should disappear from every other
 * member's "My trips" too, not just silently 404 the next time they open
 * it. Any member can delete (no owner/admin distinction exists anywhere
 * else in this app's trust model — every member already has equal
 * read/write on everything).
 */
export async function deleteTripForUser(uid: string, tripId: string): Promise<void> {
  const db = getFirestore()
  const tripRef = db.collection('trips').doc(tripId)
  const tripSnap = await tripRef.get()
  if (!tripSnap.exists) {
    throw new HttpsError('not-found', 'Trip not found')
  }

  const memberDoc = await tripRef.collection('members').doc(uid).get()
  if (!memberDoc.exists) {
    throw new HttpsError('permission-denied', 'Not a member of this trip')
  }

  const trip = tripSnap.data() as Trip
  const membersSnap = await tripRef.collection('members').get()
  const shareTokensSnap = await db
    .collection(SHARE_TOKENS_COLLECTION)
    .where('tripId', '==', tripId)
    .get()

  // One delete per member plus the share code — chunked for the same reason
  // every other per-item write list here is (see firestoreBatch.ts).
  const writes: PendingWrite[] = membersSnap.docs.map((member) => ({
    op: 'delete',
    ref: db.collection('users').doc(member.id).collection('trips').doc(tripId),
  }))
  if (trip.meta.shareCode) {
    writes.push({
      op: 'delete',
      ref: db.collection('shareCodes').doc(trip.meta.shareCode),
    })
  }
  // Family view links outlive the trip otherwise: the endpoint already 404s
  // once the trip document is gone, but leaving the tokens behind keeps a
  // growing pile of rows pointing at nothing.
  for (const tokenDoc of shareTokensSnap.docs) {
    writes.push({ op: 'delete', ref: tokenDoc.ref })
  }
  await commitInChunks(db, writes)

  // Everything under trips/{tripId} (days + their activities/restaurants,
  // corridorStops, log, members, generationStaging) in one
  // recursive delete rather than hand-walking every subcollection.
  await db.recursiveDelete(tripRef)
}

export const deleteTrip = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Must be signed in')
  }
  requireAccess(request.auth)
  const tripId = request.data?.tripId
  if (typeof tripId !== 'string') {
    throw new HttpsError('invalid-argument', 'tripId is required')
  }
  await deleteTripForUser(request.auth.uid, tripId)
  return { deleted: true }
})
