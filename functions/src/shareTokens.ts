import { randomBytes } from 'node:crypto'
import { getFirestore } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/https'
import { requireTripMember } from './authz.js'

export const SHARE_TOKENS_COLLECTION = 'shareTokens'

/**
 * Deliberately not the 6-character `meta.shareCode`. That code is typed by
 * hand into "Join trip" and is short enough to be guessed by anyone willing
 * to try (32^6 combinations), which is acceptable only because it grants
 * nothing until someone deliberately hands it over — and because joining is
 * an authenticated action. A family view link is pasted into chat threads
 * and read by whoever the relatives forward it to, with no sign-in step in
 * between, so its secrecy is the *only* access control on it: 32 random
 * bytes (43 base64url characters) are not enumerable at any rate an attacker
 * could sustain against Cloud Functions.
 */
function randomShareToken(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * base64url's own alphabet. Checked before any Firestore lookup because a
 * token goes straight into a document ID: a value containing '/' would
 * address a completely different path (or throw), and everything else is a
 * lookup that cannot possibly hit a real token anyway.
 */
const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,}$/

export interface ShareTokenDoc {
  tripId: string
  createdAt: string
  revokedAt?: string
}

/**
 * Queries on tripId alone and filters revoked ones in memory: an equality
 * filter on two fields would need a composite index, and a trip accumulates
 * at most a handful of these over its life (one live token plus however many
 * times the owner regenerated it).
 */
async function shareTokensForTrip(tripId: string) {
  const snap = await getFirestore()
    .collection(SHARE_TOKENS_COLLECTION)
    .where('tripId', '==', tripId)
    .get()
  return snap.docs
}

/** The trip's current live link, or null if it has none (or revoked it). */
export async function activeShareTokenForTrip(
  tripId: string,
): Promise<string | null> {
  const docs = await shareTokensForTrip(tripId)
  const active = docs.find((doc) => !(doc.data() as ShareTokenDoc).revokedAt)
  return active?.id ?? null
}

/**
 * Idempotent on purpose: the owner's "Get view-only link" button is a way to
 * *see* the trip's link, not to mint a new one every time it's tapped —
 * every extra token minted would be a live, forever-valid URL that nobody
 * remembers to revoke.
 */
export async function createShareTokenForTrip(
  uid: string,
  tripId: string,
): Promise<{ token: string }> {
  await requireTripMember(tripId, uid)

  const existing = await activeShareTokenForTrip(tripId)
  if (existing) return { token: existing }

  const token = randomShareToken()
  await getFirestore()
    .collection(SHARE_TOKENS_COLLECTION)
    .doc(token)
    .set({ tripId, createdAt: new Date().toISOString() } satisfies ShareTokenDoc)
  return { token }
}

/**
 * Marks every live token for the trip revoked rather than deleting it, so a
 * relative opening a dead link gets the same 404 as a made-up one while the
 * owner keeps a record that a link existed and when it was withdrawn.
 */
export async function revokeShareTokensForTrip(
  uid: string,
  tripId: string,
): Promise<{ revoked: number }> {
  await requireTripMember(tripId, uid)

  const db = getFirestore()
  const docs = await shareTokensForTrip(tripId)
  const live = docs.filter((doc) => !(doc.data() as ShareTokenDoc).revokedAt)
  if (live.length === 0) return { revoked: 0 }

  const revokedAt = new Date().toISOString()
  const batch = db.batch()
  for (const doc of live) {
    batch.update(doc.ref, { revokedAt })
  }
  await batch.commit()
  return { revoked: live.length }
}

/** The trip a live token points at, or null for unknown/revoked/malformed. */
export async function resolveShareToken(token: string): Promise<string | null> {
  if (!SHARE_TOKEN_PATTERN.test(token)) return null
  const snap = await getFirestore()
    .collection(SHARE_TOKENS_COLLECTION)
    .doc(token)
    .get()
  if (!snap.exists) return null
  const data = snap.data() as ShareTokenDoc
  if (data.revokedAt) return null
  return data.tripId
}

export const createTripShareLink = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Must be signed in')
  }
  const tripId = request.data?.tripId
  if (typeof tripId !== 'string' || !tripId) {
    throw new HttpsError('invalid-argument', 'tripId is required')
  }
  return createShareTokenForTrip(request.auth.uid, tripId)
})

export const revokeTripShareLink = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Must be signed in')
  }
  const tripId = request.data?.tripId
  if (typeof tripId !== 'string' || !tripId) {
    throw new HttpsError('invalid-argument', 'tripId is required')
  }
  return revokeShareTokensForTrip(request.auth.uid, tripId)
})
