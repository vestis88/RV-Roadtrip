import { useEffect, useState } from 'react'
import { collection, onSnapshot, orderBy, query } from 'firebase/firestore'
import type { TripDay } from '@rv/shared'
import { db } from '../lib/firebase'

export type TripDayWithId = TripDay & { id: string }

export function useTripDays(tripId: string) {
  const [days, setDays] = useState<TripDayWithId[]>([])

  useEffect(() => {
    const q = query(
      collection(db, 'trips', tripId, 'days'),
      orderBy('date'),
    )
    const unsubscribe = onSnapshot(
      q,
      (snap) => {
        setDays(
          snap.docs.map((doc) => ({ id: doc.id, ...(doc.data() as TripDay) })),
        )
      },
      (error) => console.error('[useTripDays] onSnapshot error', tripId, error),
    )
    return unsubscribe
  }, [tripId])

  return { days }
}
