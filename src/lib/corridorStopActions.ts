import { deleteDoc, doc, updateDoc } from 'firebase/firestore'
import type { CorridorStopStatus } from '@rv/shared'
import { db } from './firebase'

export async function setCorridorStopStatus(
  tripId: string,
  stopId: string,
  status: CorridorStopStatus,
) {
  await updateDoc(doc(db, 'trips', tripId, 'corridorStops', stopId), { status })
}

export async function deleteCorridorStop(tripId: string, stopId: string) {
  await deleteDoc(doc(db, 'trips', tripId, 'corridorStops', stopId))
}

/**
 * "Not interested" (2026-08-13). Looks identical to the traveler — the card
 * disappears — but leaves a tombstone instead of deleting the doc, because
 * "Find more stops" now merges into the existing corridor rather than
 * replacing it. A deleted stop is indistinguishable from one that was never
 * suggested, so the next refresh would cheerfully propose it again; a
 * `rejected` one is remembered and skipped. Nothing renders rejected stops:
 * the explore list, the route backbone and the generation seed all read
 * `candidate`/`locked` only.
 */
export async function rejectCorridorStop(tripId: string, stopId: string) {
  await setCorridorStopStatus(tripId, stopId, 'rejected')
}

/**
 * Records the driving order Google worked out for the kept stops, so it
 * survives leaving the map.
 *
 * Without this the order lived in component state and died at exactly the
 * moment it mattered: a plan request carries nothing but a trip id, so the
 * route phase re-derived the sequence from scratch and put back the detour
 * the ordering had just removed. See corridorStopSchema.routeIndex.
 *
 * Only writes stops whose position actually changed — this runs whenever
 * Directions answers, and rewriting every locked stop each time would be a
 * burst of no-op writes against a live subscription every device on the trip
 * is watching.
 */
export async function saveRouteOrder(
  tripId: string,
  orderedStops: { id: string; routeIndex?: number }[],
): Promise<void> {
  await Promise.all(
    orderedStops.map((stop, routeIndex) =>
      stop.routeIndex === routeIndex
        ? Promise.resolve()
        : updateDoc(doc(db, 'trips', tripId, 'corridorStops', stop.id), {
            routeIndex,
          }),
    ),
  )
}
