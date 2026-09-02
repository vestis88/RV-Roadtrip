import { useEffect, useState } from 'react'
import { doc, onSnapshot } from 'firebase/firestore'
import type { SearchScratch } from '@rv/shared'
import { db } from '../lib/firebase'

/**
 * The last search run from the map, streamed off the trip.
 *
 * Requested 2026-09-01: *"Make sure both rescan on map and day plans are
 * saved."* The finds used to live in one component's state, so locking the
 * phone during a ten-second Claude turn threw them away — and a search still
 * running had nothing to report on the way back either.
 *
 * Streamed rather than fetched once, so a search that finishes while the
 * traveler is on the Diary tab is waiting for them when they return, exactly
 * as a rescan's results already were.
 */
export function useSearchScratch(tripId: string) {
  // The trip the value belongs to is stored WITH it, so switching trips
  // cannot briefly show the previous one's search while the new snapshot is
  // still in flight — and nothing has to be reset from inside the effect.
  const [state, setState] = useState<{
    tripId: string
    search: SearchScratch | null
  }>({ tripId, search: null })

  useEffect(() => {
    const unsubscribe = onSnapshot(
      doc(db, 'trips', tripId, 'scratch', 'lastSearch'),
      (snap) =>
        setState({
          tripId,
          search: snap.exists() ? (snap.data() as SearchScratch) : null,
        }),
      (error) =>
        console.error('[useSearchScratch] onSnapshot error', tripId, error),
    )
    return unsubscribe
  }, [tripId])

  return { search: state.tripId === tripId ? state.search : null }
}
