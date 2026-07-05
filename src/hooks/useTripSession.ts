import { useEffect, useState } from 'react'
import { httpsCallable } from 'firebase/functions'
import { ensureSignedIn, functions } from '../lib/firebase'

export function useTripSession() {
  const [tripId, setTripId] = useState<string | null>(null)
  const [shareCode, setShareCode] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function run() {
      await ensureSignedIn()
      if (cancelled) return

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
      setShareCode(data.shareCode)
    }

    run().catch((error: unknown) => console.error('Trip session failed', error))
    return () => {
      cancelled = true
    }
  }, [])

  return { tripId, shareCode }
}
