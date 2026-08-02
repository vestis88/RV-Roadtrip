import { getFirestore, type QueryDocumentSnapshot } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/https'
import type { Activity, LatLng, Meal, Restaurant, TripDay } from '@rv/shared'
import { requireAccess } from './accessControl.js'
import { requireTripMember } from './authz.js'
import {
  RESEARCH_BATCH_SIZE,
  backfillActivities,
  backfillRestaurantsForMeal,
  googlePlacesApiKey,
} from './placesApi.js'

export type ResearchKind = 'activity' | 'restaurant'

/**
 * Dismiss-and-requeue's second tier (implemented 2026-07-30, split into a
 * per-skip and a whole-pool caller 2026-07-30): reached via
 * src/lib/placeStatus.ts once a scope's generation-time reserve
 * (placesApi.ts's RESERVE_ACTIVITY_COUNT/RESERVE_RESTAURANTS_PER_MEAL) is
 * exhausted too — either because `skipAndRequeue` wants a single immediate
 * replacement for the one just skipped (no other reserve left to promote),
 * or because `selectAndRequeue` found the whole scope drained (every
 * suggestion skipped, or one selected and every other skipped).
 *
 * Fetches RESEARCH_BATCH_SIZE fresh candidates via the same Places backfill
 * generation itself uses (no Claude call), but only the first `visibleCount`
 * of them get written as immediately-visible ('suggested'); the rest are
 * written with `reserve: true` so a run of several consecutive single-item
 * skips can keep being served instantly out of that buffer rather than
 * hitting Places on every one. `visibleCount` defaults to
 * RESEARCH_BATCH_SIZE (i.e. everything found becomes visible at once) for
 * the whole-pool caller, which wants browsing to stay open, not trickle back
 * one at a time.
 *
 * No busy-guard needed: this only ever appends new docs to a day's
 * activities/restaurants subcollection, never touches planMeta or an
 * existing item — a concurrent/duplicate call is merely redundant, not
 * corrupting, same reasoning as phase 3's rescanCorridor.
 */
export async function runResearchMoreAlternatives(
  tripId: string,
  dayId: string,
  kind: ResearchKind,
  meal?: Meal,
  visibleCount: number = RESEARCH_BATCH_SIZE,
): Promise<number> {
  const db = getFirestore()
  const dayRef = db.collection('trips').doc(tripId).collection('days').doc(dayId)
  const daySnap = await dayRef.get()
  const day = daySnap.data() as TripDay | undefined
  if (!day) {
    throw new HttpsError('not-found', 'Day not found')
  }

  const subcollection = kind === 'activity' ? 'activities' : 'restaurants'
  const collRef = dayRef.collection(subcollection)
  const existingSnap = await collRef.get()
  const existingDocs: QueryDocumentSnapshot[] =
    kind === 'restaurant'
      ? existingSnap.docs.filter((doc) => (doc.data() as Restaurant).meal === meal)
      : existingSnap.docs

  // Exclude every place already shown or already dismissed for this
  // day/meal — not just this one call's own resolutions — so "research
  // more" can't hand back something the traveler just skipped. Only works
  // for items that carry a placeId (everything resolved after this feature
  // shipped); older items without one simply can't be excluded by ID.
  const excludeIds = new Set(
    existingDocs
      .map((doc) => (doc.data() as Activity | Restaurant).placeId)
      .filter((id): id is string => !!id),
  )

  // Anchor the search at an already-resolved item's own coordinates when one
  // exists — that's exactly the point real generation originally searched
  // near (see resolveSkeletonDay's evening-slot anchor logic), which this
  // standalone follow-up call has no cheap way to re-derive on its own.
  // Falling back to the day's own overnight point only when the scope is
  // completely empty is still "in this day's town," close enough for a
  // supplementary suggestion.
  const anchorDoc = existingDocs[0]?.data() as Activity | Restaurant | undefined
  const near: LatLng = anchorDoc
    ? { lat: anchorDoc.lat, lng: anchorDoc.lng }
    : { lat: day.overnight.lat, lng: day.overnight.lng }

  const apiKey = googlePlacesApiKey.value()
  if (!apiKey) {
    throw new HttpsError(
      'failed-precondition',
      'GOOGLE_PLACES_API_KEY is not configured — research requires real data and has no synthetic fallback.',
    )
  }

  const found: (Activity | Restaurant)[] =
    kind === 'activity'
      ? await backfillActivities(near, excludeIds, apiKey, RESEARCH_BATCH_SIZE, false)
      : await backfillRestaurantsForMeal(
          meal!,
          near,
          excludeIds,
          apiKey,
          RESEARCH_BATCH_SIZE,
          false,
        )

  // Only the first visibleCount are shown now; anything past that is held
  // back as reserve rather than dumped into the row all at once (see this
  // function's own doc comment).
  const toWrite = found.map((item, index) =>
    index < visibleCount ? item : { ...item, reserve: true },
  )
  await Promise.all(toWrite.map((item) => collRef.add(item)))
  return found.length
}

export const researchMoreAlternatives = onCall(
  { secrets: [googlePlacesApiKey] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be signed in')
    }
    requireAccess(request.auth)
    const tripId = request.data?.tripId
    const dayId = request.data?.dayId
    const kind = request.data?.kind as ResearchKind | undefined
    const meal = request.data?.meal as Meal | undefined
    if (
      typeof tripId !== 'string' ||
      typeof dayId !== 'string' ||
      (kind !== 'activity' && kind !== 'restaurant')
    ) {
      throw new HttpsError(
        'invalid-argument',
        'tripId, dayId, and kind ("activity"|"restaurant") are required',
      )
    }
    if (kind === 'restaurant' && !meal) {
      throw new HttpsError(
        'invalid-argument',
        'meal is required when kind is "restaurant"',
      )
    }
    // The callable-functions wire serializer turns an omitted/undefined
    // client-side field into `null`, not a missing key — so both must be
    // treated as "not provided," not just `undefined`.
    const rawVisibleCount = request.data?.visibleCount
    if (
      rawVisibleCount != null &&
      (typeof rawVisibleCount !== 'number' ||
        !Number.isInteger(rawVisibleCount) ||
        rawVisibleCount < 1)
    ) {
      throw new HttpsError(
        'invalid-argument',
        'visibleCount, when provided, must be a positive integer',
      )
    }
    await requireTripMember(tripId, request.auth.uid)
    const added = await runResearchMoreAlternatives(
      tripId,
      dayId,
      kind,
      meal,
      rawVisibleCount ?? undefined,
    )
    return { added }
  },
)
