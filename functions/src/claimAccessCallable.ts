import { getAuth } from 'firebase-admin/auth'
import { HttpsError, onCall } from 'firebase-functions/https'
import { loadAllowedEmails } from './accessControl.js'

/**
 * Shown to the traveler verbatim, so it has to explain the situation and the
 * way out without leaking who *is* on the allowlist.
 */
export const ACCESS_DENIED_MESSAGE =
  'This Google account does not have access to this app. Sign in with an invited account, or ask the owner to add this address.'

/**
 * The one callable that deliberately does not require the `access` claim —
 * it is what hands the claim out. Everything else calls requireAccess().
 *
 * The email is read from `request.auth.token`, never from `request.data`.
 * That distinction is the whole security model here: the token is minted by
 * Firebase Auth after a real Google sign-in and verified by the callable
 * runtime before this handler runs, so its `email` is a fact. Anything in
 * `request.data` is a string the caller typed, and trusting it would let
 * anyone grant themselves access by claiming an allowlisted address.
 *
 * `email_verified` matters for the same reason: Firebase will happily mint a
 * token carrying an unverified email (e.g. an email/password account created
 * with an address the user does not control), and an unverified address is
 * an assertion, not a fact. Google sign-in sets it true; nothing else here
 * is trusted to.
 *
 * The claim lands on the user record, so it only reaches the client on the
 * *next* ID token — the caller has to force a token refresh before the new
 * access shows up in firestore.rules or in requireAccess.
 */
export const claimAccess = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Must be signed in')
  }
  const { uid, token } = request.auth
  const email = typeof token.email === 'string' ? token.email.trim().toLowerCase() : ''
  const emailVerified = token.email_verified === true

  const allowedEmails = await loadAllowedEmails()
  if (email === '' || !emailVerified || !allowedEmails.includes(email)) {
    // Logged so the owner can see who tried and decide whether to add them —
    // the caller only ever gets the generic message above.
    console.warn('claimAccess denied', {
      uid,
      email: email || '(no email on token)',
      emailVerified,
    })
    throw new HttpsError('permission-denied', ACCESS_DENIED_MESSAGE)
  }

  // setCustomUserClaims replaces the whole claims object rather than merging,
  // so anything already there (none today, but this is the kind of thing that
  // silently eats a claim someone adds later) is carried across by hand.
  //
  // Wrapped because an unhandled throw here reaches the client as a bare
  // "INTERNAL" with nothing else in it, and this is the last step of the only
  // path into the app: when it broke in production the traveler was locked
  // out with no way to find out why, and neither had I. The Admin SDK's error
  // *code* is safe to hand back — it names the fault
  // (auth/insufficient-permission, auth/user-not-found, …) without carrying
  // any detail about the project or the caller — and it is the difference
  // between "the app is broken" and a one-line fix.
  try {
    const user = await getAuth().getUser(uid)
    await getAuth().setCustomUserClaims(uid, { ...user.customClaims, access: true })
  } catch (error) {
    console.error('claimAccess could not set the access claim', { uid, error })
    const code = (error as { code?: string } | undefined)?.code ?? 'unknown'
    throw new HttpsError(
      'internal',
      `Signed in, but access could not be granted (${code}). This is a server-side fault, not a problem with the account.`,
    )
  }

  return { access: true }
})
