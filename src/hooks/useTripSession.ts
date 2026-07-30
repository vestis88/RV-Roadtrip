import { useEffect, useState } from 'react'
import { httpsCallable } from 'firebase/functions'
import { ensureSignedIn, functions } from '../lib/firebase'

export function useTripSession() {
  const [tripId, setTripId] = useState<string | null>(null)
  const [uid, setUid] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function run() {
      const user = await ensureSignedIn()
      if (cancelled) return
      setUid(user.uid)

      const params = new URLSearchParams(window.location.search)
      const joinCode = params.get('join')
      const storedTripId = localStorage.getItem('tripId')

      if (joinCode) {
        const join = httpsCallable<{ shareCode: string }, { tripId: string }>(
          functions,
          'joinTrip',
        )
        const { data } = await join({ shareCode: joinCode })
        if (cancelled) return
        localStorage.setItem('tripId', data.tripId)
        setTripId(data.tripId)
        // Strip ?join= once handled — left in place, a later reload (now
        // that switching trips is possible) would silently re-join and
        // hijack whichever trip the traveler has since switched to.
        const url = new URL(window.location.href)
        url.searchParams.delete('join')
        window.history.replaceState({}, '', url)
        return
      }

      if (storedTripId) {
        setTripId(storedTripId)
        return
      }

      const create = httpsCallable<void, { tripId: string; shareCode: string }>(
        functions,
        'createTrip',
      )
      const { data } = await create()
      if (cancelled) return
      localStorage.setItem('tripId', data.tripId)
      setTripId(data.tripId)
    }

    run().catch((error: unknown) => console.error('Trip session failed', error))
    return () => {
      cancelled = true
    }
  }, [])

  /** Switches the active trip to one the traveler is already a member of
   * (own trip list, or one just joined) — no backend call needed, membership
   * already exists. */
  function switchTrip(id: string) {
    localStorage.setItem('tripId', id)
    setTripId(id)
  }

  /** Creates a brand-new trip and switches to it immediately. */
  async function startNewTrip(): Promise<string> {
    const create = httpsCallable<void, { tripId: string; shareCode: string }>(
      functions,
      'createTrip',
    )
    const { data } = await create()
    localStorage.setItem('tripId', data.tripId)
    setTripId(data.tripId)
    return data.tripId
  }

  return { tripId, uid, switchTrip, startNewTrip }
}
