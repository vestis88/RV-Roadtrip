import { useEffect } from 'react'
import { doc, onSnapshot } from 'firebase/firestore'
import type { Trip } from '@rv/shared'
import { auth, db } from '../lib/firebase'
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
        console.error(
          '[useTrip] onSnapshot error',
          tripId,
          'currentUid=',
          auth.currentUser?.uid,
          error,
        )
        // A permission-denied read means this browser's anonymous auth
        // identity is not a recognized member of the stored trip. This can
        // legitimately happen once (e.g. Firebase Auth's session was
        // cleared independently of the `tripId` in localStorage), so it's
        // worth one automatic recovery attempt rather than freezing forever
        // on stale cached data. But it must NEVER attempt more than once
        // per tab session — if the same failure recurs (e.g. a stuck
        // multi-tab persistence lock from another open tab, or a genuinely
        // broken auth session), repeatedly reloading traps the user in an
        // unusable loop, which is worse than the original silent freeze.
        if (
          error.code === 'permission-denied' &&
          sessionStorage.getItem('permissionRecoveryAttempted') !== 'true'
        ) {
          sessionStorage.setItem('permissionRecoveryAttempted', 'true')
          localStorage.removeItem('tripId')
          window.location.reload()
        }
      },
    )
    return unsubscribe
  }, [tripId, setTrip])

  return { trip, loading: tripId != null && trip === undefined }
}
