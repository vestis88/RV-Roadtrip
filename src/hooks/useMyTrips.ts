import { useEffect, useState } from 'react'
import { collection, doc, getDoc, onSnapshot, orderBy, query } from 'firebase/firestore'
import type { PlanStatus, Trip } from '@rv/shared'
import { db } from '../lib/firebase'

export interface TripSummary {
  id: string
  name: string
  startDate: string
  endDate: string
  planStatus: PlanStatus
}

/**
 * Lists every trip this uid is a member of, via the users/{uid}/trips
 * reverse index (membership itself only lives the other direction, as
 * trips/{tripId}/members/{uid} — not queryable across trips without this).
 * Live on the index itself; each trip's own summary fields are a one-shot
 * read per change rather than N live listeners, since trip count is small
 * and this is a switcher list, not something that needs to reflect another
 * open tab's edits in real time.
 */
export function useMyTrips(uid: string | null) {
  const [trips, setTrips] = useState<TripSummary[]>([])

  useEffect(() => {
    if (!uid) return
    const membershipQuery = query(
      collection(db, 'users', uid, 'trips'),
      orderBy('joinedAt', 'desc'),
    )
    const unsubscribe = onSnapshot(
      membershipQuery,
      (snap) => {
        Promise.all(
          snap.docs.map(async (membership): Promise<TripSummary | null> => {
            const tripSnap = await getDoc(doc(db, 'trips', membership.id))
            if (!tripSnap.exists()) return null
            const trip = tripSnap.data() as Trip
            return {
              id: membership.id,
              name: trip.meta.name,
              startDate: trip.settings.startDate,
              endDate: trip.settings.endDate,
              planStatus: trip.planMeta.status,
            }
          }),
        )
          .then((results) =>
            setTrips(results.filter((t): t is TripSummary => t !== null)),
          )
          .catch((error: unknown) =>
            console.error('[useMyTrips] fetching trip summaries failed', error),
          )
      },
      (error) => console.error('[useMyTrips] onSnapshot error', error),
    )
    return unsubscribe
  }, [uid])

  return trips
}
