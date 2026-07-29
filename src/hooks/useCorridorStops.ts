import { useEffect, useState } from 'react'
import { collection, onSnapshot } from 'firebase/firestore'
import type { CorridorStop } from '@rv/shared'
import { db } from '../lib/firebase'

export type CorridorStopWithId = CorridorStop & { id: string }

export function useCorridorStops(tripId: string) {
  const [corridorStops, setCorridorStops] = useState<CorridorStopWithId[]>([])

  useEffect(() => {
    const unsubscribe = onSnapshot(
      collection(db, 'trips', tripId, 'corridorStops'),
      (snap) => {
        setCorridorStops(
          snap.docs.map((doc) => ({ id: doc.id, ...(doc.data() as CorridorStop) })),
        )
      },
      (error) => console.error('[useCorridorStops] onSnapshot error', tripId, error),
    )
    return unsubscribe
  }, [tripId])

  return { corridorStops }
}
