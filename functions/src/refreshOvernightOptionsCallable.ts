import { getFirestore } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/https'
import { requireAccess } from './accessControl.js'
import { requireTripMember } from './authz.js'
import { applyOvernightOptions } from './overnightOptions.js'
import { googlePlacesApiKey } from './placesApi.js'

/**
 * Re-resolve where every night of an existing trip is spent, without
 * regenerating the trip (implemented 2026-08-12).
 *
 * This exists because overnight resolution is genuinely separable from the
 * rest of the plan. It reads only each day's town and writes only that day's
 * options and committed overnight; drive legs are measured town-to-town, so
 * nothing it does invalidates a distance already computed. That makes it
 * cheap enough to re-run freely: a handful of corridor-wide Overpass requests
 * for the whole trip, two Places calls per day, and no Claude call at all.
 *
 * Which matters most for the case it was asked for — iterating on a two-month
 * trip. Regenerating sixty days to try a different set of campsites would mean
 * paying for the entire Claude pipeline again to change something Claude was
 * never consulted about.
 *
 * No plan-busy claim is taken. Unlike a replan this rewrites no dates, no
 * drive legs and no day structure, so a concurrent run is at worst wasted
 * work, not a corrupted trip — and gating it behind the same lock as
 * generation would make it unavailable during exactly the period someone is
 * most likely to want it.
 */
export const refreshOvernightOptions = onCall(
  {
    secrets: [googlePlacesApiKey],
    // Overpass in corridor-sized batches plus two Places calls per day. Well
    // short of a full generation, but a two-month trip is still 120 Places
    // round trips, which the 60s default would not survive.
    timeoutSeconds: 300,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be signed in')
    }
    requireAccess(request.auth)
    const tripId = request.data?.tripId
    if (typeof tripId !== 'string') {
      throw new HttpsError('invalid-argument', 'tripId is required')
    }
    await requireTripMember(tripId, request.auth.uid)

    const tripRef = getFirestore().collection('trips').doc(tripId)
    const { daysResolved, optionsWritten } = await applyOvernightOptions(tripRef)
    return { daysResolved, optionsWritten }
  },
)
