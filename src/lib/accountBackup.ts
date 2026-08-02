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

const PENDING_MERGE_KEY = 'pendingTripMerge'
// Firebase ID tokens are valid for an hour; a retry past that can't prove
// control of the abandoned uid any more, so the record is dropped rather
// than retried forever against a token the backend will reject.
const PENDING_MERGE_TTL_MS = 55 * 60 * 1000

interface PendingMerge {
  oldUid: string
  oldIdToken: string
  capturedAt: number
}

function readPendingMerge(): PendingMerge | null {
  try {
    const raw = localStorage.getItem(PENDING_MERGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as PendingMerge
    if (Date.now() - parsed.capturedAt > PENDING_MERGE_TTL_MS) {
      localStorage.removeItem(PENDING_MERGE_KEY)
      return null
    }
    return parsed
  } catch {
    return null
  }
}

async function runMerge(pending: PendingMerge): Promise<void> {
  // Claim access BEFORE merging, and refresh the token so the new claim is
  // actually in it. `mergeTrips` now requires that claim like every other
  // callable, and this path arrives at it moments after
  // signInWithCredential — a brand-new session that has never claimed
  // anything. Without this the merge fails with permission-denied on
  // exactly the flow that exists to stop trips being lost: the traveler's
  // Google account was already linked elsewhere, so their old uid has just
  // been abandoned and this call is the only thing that carries its trips
  // across.
  const claim = httpsCallable<void, { access: true }>(functions, 'claimAccess')
  await claim()
  await auth.currentUser?.getIdToken(true)

  const mergeTrips = httpsCallable<
    { oldUid: string; oldIdToken: string },
    { mergedTripIds: string[] }
  >(functions, 'mergeTrips')
  await mergeTrips({ oldUid: pending.oldUid, oldIdToken: pending.oldIdToken })
  localStorage.removeItem(PENDING_MERGE_KEY)
}

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
 *
 * The sign-in genuinely has to happen BEFORE the merge — `mergeTrips`
 * authenticates as the *surviving* account and merges into whoever is
 * calling — which makes the window between them the dangerous part: the
 * old uid is already abandoned, and nothing can re-mint its ID token. A
 * merge that failed there (flaky connection, function timeout) used to
 * lose every trip on the old account permanently, with only a generic
 * "Could not link Google account" to show for it. So the proof needed to
 * finish the merge is persisted BEFORE the identity switch, and
 * `completePendingGoogleLinkRedirect` drains it on the next load — the
 * traveler's trips come back on their own rather than needing the exact
 * moment to have gone perfectly.
 */
async function mergeIntoSurvivingAccount(
  oldUser: User,
  authError: AuthError,
): Promise<LinkGoogleResult> {
  const credential = GoogleAuthProvider.credentialFromError(authError)
  if (!credential) throw authError

  const pending: PendingMerge = {
    oldUid: oldUser.uid,
    oldIdToken: await oldUser.getIdToken(),
    capturedAt: Date.now(),
  }
  // Written before the point of no return, not after it.
  try {
    localStorage.setItem(PENDING_MERGE_KEY, JSON.stringify(pending))
  } catch {
    // A storage failure mustn't block the link itself — it only costs the
    // automatic retry, and the merge below still usually succeeds outright.
  }

  const signInResult = await signInWithCredential(auth, credential)
  await runMerge(pending)

  return { status: 'merged', email: signInResult.user.email }
}

/**
 * Finishes a merge whose callable didn't land at the time (see
 * mergeIntoSurvivingAccount). Safe to call on every load: a no-op with no
 * record stored, and `mergeTrips` is idempotent — it re-grants memberships
 * the surviving account may already have.
 */
export async function retryPendingTripMerge(): Promise<boolean> {
  const pending = readPendingMerge()
  if (!pending || !auth.currentUser) return false
  try {
    await runMerge(pending)
    return true
  } catch (error) {
    console.error('Pending trip merge retry failed — will try again next load', error)
    return false
  }
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

  // Independent of the redirect result: a merge left unfinished by the popup
  // flow needs draining too, and this is the one thing already called on
  // every load.
  await retryPendingTripMerge()

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
