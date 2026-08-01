import { getFirestore } from 'firebase-admin/firestore'
import { HttpsError } from 'firebase-functions/https'

/**
 * The only authorization boundary for every onCall callable that takes a
 * tripId: onCall handlers run on the Admin SDK, so firestore.rules'
 * isMember() check never applies to them — request.auth just proves the
 * caller is *signed in* (any Firebase user, including anonymous auth),
 * nothing about which trip they're allowed to touch. Without this, any
 * signed-in caller who obtains a tripId (a shared link, browser history,
 * guessing a Firestore auto-ID) could invoke expensive/mutating callables
 * against a trip they were never given access to. Mirrors the check
 * deleteTrip.ts already had — every other tripId-taking callable was
 * missing it.
 */
export async function requireTripMember(tripId: string, uid: string): Promise<void> {
  const memberDoc = await getFirestore()
    .collection('trips')
    .doc(tripId)
    .collection('members')
    .doc(uid)
    .get()
  if (!memberDoc.exists) {
    throw new HttpsError('permission-denied', 'Not a member of this trip')
  }
}
