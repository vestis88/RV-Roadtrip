import { getFirestore } from 'firebase-admin/firestore'
import { HttpsError, type CallableRequest } from 'firebase-functions/https'

export const ALLOWLIST_DOC_PATH = ['config', 'allowlist'] as const

/**
 * Anything separating one hand-typed address from the next. The owner
 * maintains this field in the Firebase console, so the list may plausibly
 * arrive comma-separated, semicolon-separated, or one per line — none of
 * which is a mistake worth locking someone out of their own app over.
 */
const EMAIL_SEPARATORS = /[,;\s]+/

/**
 * The people allowed to use this app, kept in one hand-edited Firestore
 * document (`config/allowlist`, field `emails`) rather than a collection or
 * an env var: the owner maintains it from the Firebase console in seconds,
 * and firestore.rules denies every client read of `config/**` so nobody but
 * the Admin SDK ever sees it.
 *
 * Accepts either a string or an array of strings, because the console's type
 * dropdown offers "array" right beside "string" and a list of addresses
 * invites it. This cost the owner a real lockout: the field was written the
 * way the UI suggested, every address in it was correct, and the app told
 * them their own account wasn't invited. Being liberal about the shape
 * weakens nothing — each entry still has to match a verified address
 * exactly.
 *
 * Never throws. A missing document, a missing field or a Firestore outage
 * all yield `[]`, which fails *closed* — an empty allowlist matches nobody,
 * so claimAccess refuses everyone rather than handing out access while the
 * source of truth is unreadable. The warning is there because that state is
 * indistinguishable from "the owner deleted the doc by accident" and needs
 * to be visible in the logs.
 */
export async function loadAllowedEmails(): Promise<string[]> {
  let raw: unknown
  try {
    const snap = await getFirestore()
      .collection(ALLOWLIST_DOC_PATH[0])
      .doc(ALLOWLIST_DOC_PATH[1])
      .get()
    if (!snap.exists) {
      console.warn(
        'Access allowlist config/allowlist is missing — nobody can claim access until it is restored',
      )
      return []
    }
    raw = snap.data()?.emails
  } catch (error) {
    console.error('Failed to read access allowlist config/allowlist', error)
    return []
  }

  const entries = Array.isArray(raw)
    ? raw.filter((entry): entry is string => typeof entry === 'string')
    : typeof raw === 'string'
      ? [raw]
      : []

  const emails = entries
    .flatMap((entry) => entry.split(EMAIL_SEPARATORS))
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email !== '')

  if (emails.length === 0) {
    console.warn(
      'Access allowlist config/allowlist has no usable emails field — nobody can claim access',
    )
  }
  return emails
}

/**
 * "May this user use the app at all" — the callable-side counterpart of
 * firestore.rules' hasAccess(). The `access` custom claim is set only by
 * claimAccess, only for a verified email on the allowlist, so it is the one
 * thing on the token that proves the caller is one of the trusted accounts
 * rather than merely some signed-in Firebase user.
 *
 * This is NOT a replacement for requireTripMember and requireTripMember is
 * not a replacement for this. They answer different questions:
 *
 *   requireAccess(auth)             — may this user use the app at all?
 *   requireTripMember(tripId, uid)  — may this user touch THIS trip?
 *
 * Without requireAccess, any visitor who signs in gets to spend the owner's
 * Claude/Places budget on a trip of their own. Without requireTripMember, a
 * trusted user could still reach into a trip they were never given. Every
 * tripId-taking callable needs both, in that order — the claim check is
 * free, the membership check costs a Firestore read.
 */
export function requireAccess(auth: CallableRequest['auth']): void {
  if (auth?.token?.access !== true) {
    throw new HttpsError('permission-denied', 'This account does not have access to this app')
  }
}
