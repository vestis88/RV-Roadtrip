import { useEffect, useState } from 'react'
import { collection, onSnapshot } from 'firebase/firestore'
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
  // `dayIds` is typically a fresh array every render (the caller derives it
  // via `days.map(...)`) — depending on it directly would tear the listeners
  // below down and rebuild them on every render. This is the same set of IDs
  // in a form stable across renders, so the effect only actually resubscribes
  // when the day list itself changes.
  const dayIdsKey = [...dayIds].sort().join(',')

  // Reset synchronously during render when the trip/day-list identity
  // changes (React's documented pattern for "adjusting state when a prop
  // changes"), rather than inside the effect below — a replan replaces a
  // day's activities/restaurants outright (same dayId, new documents), and
  // switching trips can easily land on a new trip whose day IDs — plain
  // date strings — coincide with ones already seen under a different trip.
  // A cache that only ever adds entries has no way to notice either case and
  // just keeps serving whatever it read the first time. Reported as:
  // switching to a new destination still showed the previous plan's route.
  const identity = `${tripId}|${dayIdsKey}|${enabled}`
  const [loadedFor, setLoadedFor] = useState(identity)
  if (loadedFor !== identity) {
    setLoadedFor(identity)
    setPlaces({})
  }

  useEffect(() => {
    const ids = dayIdsKey === '' ? [] : dayIdsKey.split(',')
    if (!enabled || ids.length === 0) return

    // Live listeners, not a one-time fetch: only this way does an actual
    // content change (a replan replacing a day's documents) ever get picked
    // up after the initial read.
    const dataByDay = new Map<string, DayPlaces>()

    const unsubscribes = ids.flatMap((dayId) => {
      function commit() {
        setPlaces((prev) => ({
          ...prev,
          [dayId]: dataByDay.get(dayId) ?? { activities: [], restaurants: [] },
        }))
      }

      const unsubActivities = onSnapshot(
        collection(db, 'trips', tripId, 'days', dayId, 'activities'),
        (snap) => {
          const existing =
            dataByDay.get(dayId) ?? { activities: [], restaurants: [] }
          dataByDay.set(dayId, {
            ...existing,
            activities: snap.docs.map((d) => d.data() as Activity),
          })
          commit()
        },
        (error) =>
          console.error(
            '[useDayPlaces] activities onSnapshot error',
            tripId,
            dayId,
            error,
          ),
      )
      const unsubRestaurants = onSnapshot(
        collection(db, 'trips', tripId, 'days', dayId, 'restaurants'),
        (snap) => {
          const existing =
            dataByDay.get(dayId) ?? { activities: [], restaurants: [] }
          dataByDay.set(dayId, {
            ...existing,
            restaurants: snap.docs.map((d) => d.data() as Restaurant),
          })
          commit()
        },
        (error) =>
          console.error(
            '[useDayPlaces] restaurants onSnapshot error',
            tripId,
            dayId,
            error,
          ),
      )

      return [unsubActivities, unsubRestaurants]
    })

    return () => {
      unsubscribes.forEach((unsubscribe) => unsubscribe())
    }
  }, [tripId, dayIdsKey, enabled])

  return places
}
