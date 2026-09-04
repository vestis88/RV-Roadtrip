import { useEffect, useState } from 'react'
import { collection, doc, onSnapshot } from 'firebase/firestore'
import type {
  Activity,
  OvernightStopCandidate,
  Restaurant,
  TripDay,
} from '@rv/shared'
import { db } from '../lib/firebase'

export type ActivityWithId = Activity & { id: string }
export type RestaurantWithId = Restaurant & { id: string }
export type OvernightOptionWithId = OvernightStopCandidate & { id: string }

export function useDayDetail(tripId: string, dayId: string | undefined) {
  const [day, setDay] = useState<TripDay | undefined>(undefined)
  const [activities, setActivities] = useState<ActivityWithId[]>([])
  const [restaurants, setRestaurants] = useState<RestaurantWithId[]>([])
  /**
   * The places this day COULD sleep, as opposed to the one it does.
   *
   * Requested 2026-09-02: *"I want the overnight stop options to show on the
   * map in a similar way as activities and restaurants."* They were read
   * only by the picker, and only once it was opened — so a decision about
   * where to sleep was made from a list of names while the map beside it
   * showed nothing but the current choice. Streamed like everything else on
   * the day, so the pins are simply there.
   */
  const [overnightOptions, setOvernightOptions] = useState<
    OvernightOptionWithId[]
  >([])
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
          snap.docs
            .map((d) => ({ id: d.id, ...(d.data() as Activity) }))
            // Dismiss-and-requeue's hidden reserve pool (see activitySchema's
            // own comment) — invisible everywhere until promoted, at which
            // point it's indistinguishable from any other suggested item.
            .filter((activity) => !activity.reserve),
        ),
      (error) =>
        console.error('[useDayDetail] activities onSnapshot error', dayId, error),
    )
    const unsubRestaurants = onSnapshot(
      collection(dayRef, 'restaurants'),
      (snap) =>
        setRestaurants(
          snap.docs
            .map((d) => ({ id: d.id, ...(d.data() as Restaurant) }))
            .filter((restaurant) => !restaurant.reserve),
        ),
      (error) =>
        console.error('[useDayDetail] restaurants onSnapshot error', dayId, error),
    )
    const unsubOvernight = onSnapshot(
      collection(dayRef, 'overnightOptions'),
      (snap) =>
        setOvernightOptions(
          snap.docs.map((d) => ({
            id: d.id,
            ...(d.data() as OvernightStopCandidate),
          })),
        ),
      (error) =>
        console.error(
          '[useDayDetail] overnightOptions onSnapshot error',
          dayId,
          error,
        ),
    )
    return () => {
      unsubDay()
      unsubActivities()
      unsubRestaurants()
      unsubOvernight()
    }
  }, [tripId, dayId])

  return { day, activities, restaurants, overnightOptions, loading }
}
