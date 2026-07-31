import {
  GoogleAuthProvider,
  getRedirectResult,
  linkWithPopup,
  linkWithRedirect,
  signInWithCredential,
  type AuthError,
  type User,
  type UserCredential,
} from 'firebase/auth'
import { httpsCallable } from 'firebase/functions'
import { auth, functions } from './firebase'

export type LinkGoogleResult =
  | { status: 'linked'; email: string | null }
  | { status: 'merged'; email: string | null }
  | { status: 'cancelled' }
  | { status: 'redirecting' }

/**
 * The one real wrinkle in linking: if this Google account is already
 * linked to a DIFFERENT Firebase user (e.g. it already backed up another
 * device), Firebase refuses the link with `auth/credential-already-in-use`
 * and expects the caller to sign into that existing account instead. That
 * abandons `oldUser`'s uid, so before switching, this captures its ID token
 * and hands it to the `mergeTrips` callable — the only way to prove to the
 * backend this caller really did control the about-to-be-abandoned
 * identity — carrying every trip it belonged to across to the surviving
 * account. Shared between the popup and redirect flows below, since
 * Firebase surfaces this the same way either way: the link attempt itself
 * fails with this code, `oldUser` is untouched, and only signing in with
 * the extracted credential actually switches identities.
 */
async function mergeIntoSurvivingAccount(
  oldUser: User,
  authError: AuthError,
): Promise<LinkGoogleResult> {
  const credential = GoogleAuthProvider.credentialFromError(authError)
  if (!credential) throw authError

  const oldUid = oldUser.uid
  const oldIdToken = await oldUser.getIdToken()
  const signInResult = await signInWithCredential(auth, credential)

  const mergeTrips = httpsCallable<
    { oldUid: string; oldIdToken: string },
    { mergedTripIds: string[] }
  >(functions, 'mergeTrips')
  await mergeTrips({ oldUid, oldIdToken })

  return { status: 'merged', email: signInResult.user.email }
}

function toLinkedResult(result: UserCredential): LinkGoogleResult {
  return { status: 'linked', email: result.user.email }
}

/**
 * Links the current (anonymous) account to a Google account, preserving
 * this device's uid — trips stay exactly where they are, no migration, no
 * firestore.rules change (every rule is a plain uid comparison already).
 *
 * Tries a popup first (instant, no navigation) and falls back to a
 * full-page redirect when the popup itself couldn't run — reported as
 * "Could not link Google account" with no further detail on an iPhone,
 * which matches `auth/popup-blocked`/`auth/operation-not-supported-in-
 * this-environment`: mobile Safari, and especially an installed/standalone
 * PWA (no normal browser chrome to host a popup in), frequently can't open
 * or complete an OAuth popup at all. A popup the traveler deliberately
 * closed (`popup-closed-by-user`/`cancelled-popup-request`) is a real
 * cancel, not a failure to fall back from.
 */
export async function linkGoogleAccount(): Promise<LinkGoogleResult> {
  const currentUser = auth.currentUser
  if (!currentUser) throw new Error('Not signed in')

  const provider = new GoogleAuthProvider()
  try {
    return toLinkedResult(await linkWithPopup(currentUser, provider))
  } catch (error) {
    const authError = error as AuthError
    if (authError.code === 'auth/credential-already-in-use') {
      return mergeIntoSurvivingAccount(currentUser, authError)
    }
    if (
      authError.code === 'auth/popup-closed-by-user' ||
      authError.code === 'auth/cancelled-popup-request'
    ) {
      return { status: 'cancelled' }
    }
    if (
      authError.code === 'auth/popup-blocked' ||
      authError.code === 'auth/operation-not-supported-in-this-environment'
    ) {
      await linkWithRedirect(currentUser, provider)
      // The page navigates away to Google's consent screen here — nothing
      // after this point runs. completePendingGoogleLinkRedirect (called on
      // the next load) finishes the flow when the traveler comes back.
      return { status: 'redirecting' }
    }
    throw error
  }
}

/**
 * Call once on app load (AccountBackupMenu does this) to finish a link that
 * fell back to `linkWithRedirect` above — a no-op (`null`) on every load
 * that isn't the return trip from Google's consent screen.
 */
export async function completePendingGoogleLinkRedirect(): Promise<LinkGoogleResult | null> {
  const currentUser = auth.currentUser
  if (!currentUser) return null

  try {
    const result = await getRedirectResult(auth)
    return result ? toLinkedResult(result) : null
  } catch (error) {
    const authError = error as AuthError
    if (authError.code === 'auth/credential-already-in-use') {
      return mergeIntoSurvivingAccount(currentUser, authError)
    }
    throw error
  }
}
