import { useEffect } from 'react'
import { doc, onSnapshot } from 'firebase/firestore'
import type { Trip } from '@rv/shared'
import { db } from '../lib/firebase'
import { useTripStore } from '../store/tripStore'

export function useTrip(tripId: string | null) {
  const trip = useTripStore((state) => (tripId ? state.trips[tripId] : undefined))
  const setTrip = useTripStore((state) => state.setTrip)

  useEffect(() => {
    if (!tripId) return
    const unsubscribe = onSnapshot(
      doc(db, 'trips', tripId),
      (snap) => {
        if (snap.exists()) {
          setTrip(tripId, snap.data() as Trip)
        }
      },
      (error) => {
        console.error('[useTrip] onSnapshot error', tripId, error)
        // A permission-denied read means this browser's anonymous auth
        // identity is no longer a recognized member of the stored trip —
        // e.g. Firebase Auth's session was cleared independently of the
        // `tripId` in localStorage (two separate storage mechanisms that
        // can fall out of sync). Without recovery, the app freezes forever
        // on whatever was last cached, with no way for the user to fix it
        // short of clearing all site data themselves. Self-heal by
        // dropping the now-inaccessible trip ID and starting fresh — guard
        // against a reload loop if this somehow keeps happening.
        if (
          error.code === 'permission-denied' &&
          sessionStorage.getItem('recoveredFromPermissionDenied') !== tripId
        ) {
          sessionStorage.setItem('recoveredFromPermissionDenied', tripId)
          localStorage.removeItem('tripId')
          window.location.reload()
        }
      },
    )
    return unsubscribe
  }, [tripId, setTrip])

  return { trip, loading: tripId != null && trip === undefined }
}
