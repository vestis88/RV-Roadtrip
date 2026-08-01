import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/https'
import { commitInChunks, type PendingWrite } from './firestoreBatch.js'

/**
 * Carries every trip membership from an abandoned identity (oldUid) across
 * to the caller's own uid. Needed for Google-account backup/linking's one
 * real wrinkle: if a traveler links a second device's anonymous account to
 * a Google account already linked to a different (surviving) Firebase user
 * — e.g. they backed up device A already, and are now backing up device B
 * with the same Google account — Firebase refuses the link
 * (`auth/credential-already-in-use`) and expects the client to sign into
 * the surviving account instead. That abandons device B's local anonymous
 * uid and, with it, any trips it owned, unless they're carried across here.
 *
 * `oldIdToken` (the abandoned account's own ID token, captured client-side
 * right before the switch) is what proves the caller actually controlled
 * that identity — trusting a bare `oldUid` string alone would let anyone
 * graft themselves onto another traveler's trips just by guessing/knowing
 * their uid.
 */
export async function mergeTripsForUid(
  newUid: string,
  oldUid: string,
  oldIdToken: string,
): Promise<{ mergedTripIds: string[] }> {
  const decoded = await getAuth().verifyIdToken(oldIdToken)
  if (decoded.uid !== oldUid) {
    throw new HttpsError(
      'permission-denied',
      'oldIdToken does not belong to oldUid',
    )
  }
  if (oldUid === newUid) {
    return { mergedTripIds: [] }
  }

  const db = getFirestore()
  const oldTripsSnap = await db
    .collection('users')
    .doc(oldUid)
    .collection('trips')
    .get()
  if (oldTripsSnap.empty) {
    return { mergedTripIds: [] }
  }

  const now = new Date().toISOString()
  // Two writes per trip, so a heavily-shared account merging enough trips
  // could exceed Firestore's 500-op batch cap — chunked like every other
  // per-item write list in this codebase (see firestoreBatch.ts).
  const writes: PendingWrite[] = []
  const mergedTripIds: string[] = []
  for (const tripDoc of oldTripsSnap.docs) {
    const tripId = tripDoc.id
    mergedTripIds.push(tripId)
    writes.push({
      op: 'set',
      ref: db.collection('trips').doc(tripId).collection('members').doc(newUid),
      data: { joinedAt: now },
      options: { merge: true },
    })
    writes.push({
      op: 'set',
      ref: db.collection('users').doc(newUid).collection('trips').doc(tripId),
      data: { joinedAt: now },
      options: { merge: true },
    })
  }
  await commitInChunks(db, writes)

  return { mergedTripIds }
}

export const mergeTrips = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Must be signed in')
  }
  const oldUid = request.data?.oldUid
  const oldIdToken = request.data?.oldIdToken
  if (typeof oldUid !== 'string' || typeof oldIdToken !== 'string') {
    throw new HttpsError(
      'invalid-argument',
      'oldUid and oldIdToken are required',
    )
  }
  return mergeTripsForUid(request.auth.uid, oldUid, oldIdToken)
})
