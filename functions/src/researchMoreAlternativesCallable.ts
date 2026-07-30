import { getFirestore, type QueryDocumentSnapshot } from 'firebase-admin/firestore'
import { HttpsError, onCall } from 'firebase-functions/https'
import type { Activity, LatLng, Meal, Restaurant, TripDay } from '@rv/shared'
import {
  RESEARCH_BATCH_SIZE,
  backfillActivities,
  backfillRestaurantsForMeal,
  googlePlacesApiKey,
} from './placesApi.js'

export type ResearchKind = 'activity' | 'restaurant'

/**
 * Dismiss-and-requeue's second tier (implemented 2026-07-30): the client
 * (src/lib/placeStatus.ts's skipAndRequeue) calls this only once BOTH a
 * day's displayed items and their generation-time reserve (placesApi.ts's
 * RESERVE_ACTIVITY_COUNT/RESERVE_RESTAURANTS_PER_MEAL) are exhausted for a
 * scope — every suggestion skipped, or one selected and every other skipped.
 * Tops the pool back up with RESEARCH_BATCH_SIZE fresh, immediately-visible
 * ('suggested', not reserve) candidates via the same Places backfill
 * generation itself uses — no Claude call, matching the backfill's own
 * "another one via Places, avoiding what's already resolved" character
 * rather than a full re-curation.
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

  await Promise.all(found.map((item) => collRef.add(item)))
  return found.length
}

export const researchMoreAlternatives = onCall(
  { secrets: [googlePlacesApiKey] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Must be signed in')
    }
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
    const added = await runResearchMoreAlternatives(tripId, dayId, kind, meal)
    return { added }
  },
)
