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
      (error) => console.error('[useTrip] onSnapshot error', tripId, error),
    )
    return unsubscribe
  }, [tripId, setTrip])

  return { trip, loading: tripId != null && trip === undefined }
}
