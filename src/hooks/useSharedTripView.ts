import { useEffect, useState } from 'react'
import type { SharedTripView } from '@rv/shared'
import {
  SHARED_TRIP_POLL_MS,
  fetchSharedTripView,
} from '../lib/sharedTripView'

export type SharedTripViewStatus = 'loading' | 'ready' | 'not-found' | 'error'

/**
 * Polls instead of subscribing: the guest page holds no Firestore connection
 * at all (that would need a signed-in user and read access to the trip),
 * so a repeated read of the endpoint is what keeps the page current.
 *
 * Only while the tab is actually visible, and with an immediate re-read when
 * it becomes visible again — a link left open in a background tab for a week
 * should cost nothing, and the moment a relative switches back to it is
 * exactly when a stale view would be noticed.
 */
export function useSharedTripView(token: string | undefined) {
  const [view, setView] = useState<SharedTripView | null>(null)
  const [status, setStatus] = useState<SharedTripViewStatus>('loading')

  useEffect(() => {
    if (!token) return

    let cancelled = false
    const controller = new AbortController()

    async function load() {
      try {
        const next = await fetchSharedTripView(token!, controller.signal)
        if (cancelled) return
        setView(next)
        setStatus(next ? 'ready' : 'not-found')
      } catch (error) {
        if (cancelled || controller.signal.aborted) return
        console.error('[useSharedTripView] fetch failed', error)
        // Only a first load has nothing to show. A poll that fails (a tunnel,
        // a flaky café wifi) leaves the last good view on screen rather than
        // replacing a perfectly readable itinerary with an error.
        setStatus((current) => (current === 'ready' ? 'ready' : 'error'))
      }
    }

    void load()
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, SHARED_TRIP_POLL_MS)

    function onVisibilityChange() {
      if (document.visibilityState === 'visible') void load()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      cancelled = true
      controller.abort()
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [token])

  // Derived rather than pushed into state by the effect: a route with no
  // token at all can only ever be "no such link", and there is nothing to
  // fetch or unset for it.
  return { view, status: token ? status : ('not-found' as const) }
}
