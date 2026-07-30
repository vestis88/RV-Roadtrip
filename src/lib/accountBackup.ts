import {
  GoogleAuthProvider,
  linkWithPopup,
  signInWithCredential,
  type AuthError,
} from 'firebase/auth'
import { httpsCallable } from 'firebase/functions'
import { auth, functions } from './firebase'

export type LinkGoogleResult =
  | { status: 'linked'; email: string | null }
  | { status: 'merged'; email: string | null }
  | { status: 'cancelled' }

/**
 * Links the current (anonymous) account to a Google account, preserving
 * this device's uid — trips stay exactly where they are, no migration, no
 * firestore.rules change (every rule is a plain uid comparison already).
 *
 * The one real wrinkle: if this Google account is already linked to a
 * DIFFERENT Firebase user (e.g. it already backed up another device),
 * Firebase refuses the link with `auth/credential-already-in-use` and
 * expects the caller to sign into that existing account instead. That
 * abandons this device's anonymous uid, so before switching, this captures
 * its ID token and hands it to the `mergeTrips` callable — the only way to
 * prove to the backend this caller really did control the about-to-be-
 * abandoned identity — carrying every trip it belonged to across to the
 * surviving account.
 */
export async function linkGoogleAccount(): Promise<LinkGoogleResult> {
  const currentUser = auth.currentUser
  if (!currentUser) throw new Error('Not signed in')

  const provider = new GoogleAuthProvider()
  try {
    const result = await linkWithPopup(currentUser, provider)
    return { status: 'linked', email: result.user.email }
  } catch (error) {
    const authError = error as AuthError
    if (authError.code === 'auth/credential-already-in-use') {
      const credential = GoogleAuthProvider.credentialFromError(authError)
      if (!credential) throw error

      const oldUid = currentUser.uid
      const oldIdToken = await currentUser.getIdToken()
      const signInResult = await signInWithCredential(auth, credential)

      const mergeTrips = httpsCallable<
        { oldUid: string; oldIdToken: string },
        { mergedTripIds: string[] }
      >(functions, 'mergeTrips')
      await mergeTrips({ oldUid, oldIdToken })

      return { status: 'merged', email: signInResult.user.email }
    }
    if (
      authError.code === 'auth/popup-closed-by-user' ||
      authError.code === 'auth/cancelled-popup-request'
    ) {
      return { status: 'cancelled' }
    }
    throw error
  }
}
