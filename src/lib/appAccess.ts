import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type AuthError,
  type User,
} from 'firebase/auth'
import { httpsCallable } from 'firebase/functions'
import { auth, functions } from './firebase'
import { linkGoogleAccount } from './accountBackup'

/**
 * Whether this browser may use the app at all.
 *
 * Distinct from "may this account touch this trip", which membership has
 * always answered. Until now there was no answer to the first question:
 * opening the URL minted an anonymous account, a trip and a share code,
 * and every Claude-backed button worked — so anyone who found the address
 * could spend the owner's API budget. This gate is that missing answer.
 *
 * - `checking` — Firebase hasn't reported an auth state yet.
 * - `signed-out` — nobody is signed in, or the signed-in account is the
 *   old anonymous kind that predates the gate.
 * - `denied` — signed in with a real account that isn't on the allowlist.
 * - `granted` — the account carries the `access` custom claim.
 *
 * The claim is the real boundary: firestore.rules and every callable check
 * it server-side. Nothing here is load-bearing on its own — this module
 * only decides what to render.
 */
export type AccessState = 'checking' | 'signed-out' | 'denied' | 'granted'

export interface AccessStatus {
  state: AccessState
  /** Set on `denied`, to say which account was refused. */
  email?: string | null
  /**
   * True when the signed-in account is still the anonymous one this
   * browser has been using. Linking (rather than signing in fresh) is then
   * the only way to keep its trips — see attachGoogleAccount.
   */
  hasAnonymousTrips: boolean
}

async function readAccessClaim(user: User, forceRefresh: boolean): Promise<boolean> {
  const token = await user.getIdTokenResult(forceRefresh)
  return token.claims.access === true
}

/**
 * Asks the server to grant this account access, then refreshes the ID
 * token so the new claim is actually present in it — a claim set
 * server-side is invisible to the client (and to Firestore rules on this
 * connection) until the token is re-minted.
 */
async function requestAccessClaim(user: User): Promise<boolean> {
  const claim = httpsCallable<void, { access: true }>(functions, 'claimAccess')
  await claim()
  return readAccessClaim(user, true)
}

async function statusFor(user: User | null): Promise<AccessStatus> {
  if (!user) return { state: 'signed-out', hasAnonymousTrips: false }
  if (user.isAnonymous) {
    // Pre-gate sessions land here. They may well own trips, so the sign-in
    // screen must offer to LINK rather than replace this identity.
    return { state: 'signed-out', hasAnonymousTrips: true }
  }
  if (await readAccessClaim(user, false)) {
    return { state: 'granted', email: user.email, hasAnonymousTrips: false }
  }
  try {
    if (await requestAccessClaim(user)) {
      return { state: 'granted', email: user.email, hasAnonymousTrips: false }
    }
  } catch (error) {
    console.error('Access request refused', error)
  }
  return { state: 'denied', email: user.email, hasAnonymousTrips: false }
}

/**
 * Reports access status now and on every subsequent auth change. Unlike
 * the app's original one-shot sign-in, this keeps listening: signing in,
 * signing out and linking all have to move the UI without a reload.
 */
export function watchAccess(onChange: (status: AccessStatus) => void): () => void {
  return onAuthStateChanged(
    auth,
    (user) => {
      void statusFor(user).then(onChange)
    },
    (error) => {
      console.error('Auth state error', error)
      onChange({ state: 'signed-out', hasAnonymousTrips: false })
    },
  )
}

/**
 * Signs in with Google — or, when this browser still holds the anonymous
 * account it has been using all along, LINKS Google to that account
 * instead.
 *
 * That distinction is the whole migration story. Trips belong to a uid;
 * linking keeps the uid, so they stay exactly where they are. Signing in
 * fresh on a device that owns trips would strand them behind an identity
 * nobody is using any more, recoverable only via a share code the traveler
 * can no longer see. So the choice is made here, from what the session
 * actually is, rather than left to the traveler to get right.
 */
export async function attachGoogleAccount(): Promise<void> {
  const current = auth.currentUser
  if (current?.isAnonymous) {
    await linkGoogleAccount()
    return
  }
  const provider = new GoogleAuthProvider()
  try {
    await signInWithPopup(auth, provider)
  } catch (error) {
    const authError = error as AuthError
    if (
      authError.code === 'auth/popup-closed-by-user' ||
      authError.code === 'auth/cancelled-popup-request'
    ) {
      return
    }
    // Same reasoning as linkGoogleAccount's own fallback: an installed PWA
    // or mobile Safari frequently cannot host an OAuth popup at all.
    if (
      authError.code === 'auth/popup-blocked' ||
      authError.code === 'auth/operation-not-supported-in-this-environment'
    ) {
      await signInWithRedirect(auth, provider)
      return
    }
    throw error
  }
}

/**
 * Signing out has to clear the stored trip too. `tripId` is not scoped to
 * an account, so leaving it behind would point the next person who signs
 * in on this device at a trip they may have no membership of — which reads
 * as a permissions failure rather than as the leftover it is.
 */
export async function signOutOfApp(): Promise<void> {
  localStorage.removeItem('tripId')
  await signOut(auth)
}
