import { useEffect, useState } from 'react'
import { collection, doc, onSnapshot } from 'firebase/firestore'
import type { Activity, Restaurant, TripDay } from '@rv/shared'
import { db } from '../lib/firebase'

export type ActivityWithId = Activity & { id: string }
export type RestaurantWithId = Restaurant & { id: string }

export function useDayDetail(tripId: string, dayId: string | undefined) {
  const [day, setDay] = useState<TripDay | undefined>(undefined)
  const [activities, setActivities] = useState<ActivityWithId[]>([])
  const [restaurants, setRestaurants] = useState<RestaurantWithId[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!dayId) return
    const dayRef = doc(db, 'trips', tripId, 'days', dayId)
    const unsubDay = onSnapshot(
      dayRef,
      (snap) => {
        setDay(snap.exists() ? (snap.data() as TripDay) : undefined)
        setLoading(false)
      },
      (error) => console.error('[useDayDetail] day onSnapshot error', dayId, error),
    )
    const unsubActivities = onSnapshot(
      collection(dayRef, 'activities'),
      (snap) =>
        setActivities(
          snap.docs.map((d) => ({ id: d.id, ...(d.data() as Activity) })),
        ),
      (error) =>
        console.error('[useDayDetail] activities onSnapshot error', dayId, error),
    )
    const unsubRestaurants = onSnapshot(
      collection(dayRef, 'restaurants'),
      (snap) =>
        setRestaurants(
          snap.docs.map((d) => ({ id: d.id, ...(d.data() as Restaurant) })),
        ),
      (error) =>
        console.error('[useDayDetail] restaurants onSnapshot error', dayId, error),
    )
    return () => {
      unsubDay()
      unsubActivities()
      unsubRestaurants()
    }
  }, [tripId, dayId])

  return { day, activities, restaurants, loading }
}
