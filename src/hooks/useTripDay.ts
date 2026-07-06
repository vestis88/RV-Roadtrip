import { useEffect, useState } from 'react'
import { doc, onSnapshot } from 'firebase/firestore'
import type { TripDay } from '@rv/shared'
import { db } from '../lib/firebase'

export function useTripDay(tripId: string, dayId: string | undefined) {
  const [day, setDay] = useState<TripDay | undefined>(undefined)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!dayId) return
    const unsubscribe = onSnapshot(
      doc(db, 'trips', tripId, 'days', dayId),
      (snap) => {
        setDay(snap.exists() ? (snap.data() as TripDay) : undefined)
        setLoading(false)
      },
    )
    return unsubscribe
  }, [tripId, dayId])

  return { day, loading }
}
