import { useEffect, useRef, useState } from 'react'
import { collection, getDocs } from 'firebase/firestore'
import type { Activity, Restaurant } from '@rv/shared'
import { db } from '../lib/firebase'

export interface DayPlaces {
  activities: Activity[]
  restaurants: Restaurant[]
}

export function useDayPlaces(
  tripId: string,
  dayIds: string[],
  enabled: boolean,
) {
  const [places, setPlaces] = useState<Record<string, DayPlaces>>({})
  const fetchedIds = useRef(new Set<string>())

  useEffect(() => {
    if (!enabled) return
    const missingIds = dayIds.filter((id) => !fetchedIds.current.has(id))
    if (missingIds.length === 0) return
    missingIds.forEach((id) => fetchedIds.current.add(id))

    let cancelled = false

    async function run() {
      const entries = await Promise.all(
        missingIds.map(async (dayId) => {
          const dayRef = collection(db, 'trips', tripId, 'days', dayId, 'activities')
          const restaurantRef = collection(
            db,
            'trips',
            tripId,
            'days',
            dayId,
            'restaurants',
          )
          const [activitiesSnap, restaurantsSnap] = await Promise.all([
            getDocs(dayRef),
            getDocs(restaurantRef),
          ])
          return [
            dayId,
            {
              activities: activitiesSnap.docs.map((d) => d.data() as Activity),
              restaurants: restaurantsSnap.docs.map(
                (d) => d.data() as Restaurant,
              ),
            },
          ] as const
        }),
      )
      if (cancelled) return
      setPlaces((prev) => {
        const next = { ...prev }
        for (const [dayId, dayPlaces] of entries) {
          next[dayId] = dayPlaces
        }
        return next
      })
    }

    run().catch((error: unknown) =>
      console.error('[useDayPlaces] fetch failed', tripId, error),
    )
    return () => {
      cancelled = true
    }
  }, [tripId, dayIds, enabled])

  return places
}
