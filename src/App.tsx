import { useEffect, useState } from 'react'
import { doc, updateDoc } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, ensureSignedIn, functions } from './lib/firebase'
import { useTrip } from './hooks/useTrip'

function useTripSession() {
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

function App() {
  const { tripId, shareCode } = useTripSession()
  const { trip, loading } = useTrip(tripId)
  const [nameDraft, setNameDraft] = useState('')
  const [isEditingName, setIsEditingName] = useState(false)

  if (trip && !isEditingName && nameDraft !== trip.meta.name) {
    setNameDraft(trip.meta.name)
  }

  async function saveName() {
    setIsEditingName(false)
    if (!tripId || !nameDraft) return
    await updateDoc(doc(db, 'trips', tripId), { 'meta.name': nameDraft })
  }

  return (
    <main className="flex min-h-svh items-center justify-center bg-white px-4 dark:bg-neutral-900">
      <div className="w-full max-w-sm text-center">
        <h1 className="text-3xl font-semibold text-neutral-900 dark:text-white">
          RV Road Trip Planner
        </h1>
        {loading || !trip ? (
          <p className="mt-2 text-neutral-500 dark:text-neutral-400">
            Loading trip…
          </p>
        ) : (
          <div className="mt-4 space-y-2">
            <input
              className="w-full rounded border border-neutral-300 px-3 py-2 text-center dark:border-neutral-700 dark:bg-neutral-800 dark:text-white"
              data-testid="trip-name-input"
              value={nameDraft}
              onChange={(event) => setNameDraft(event.target.value)}
              onFocus={() => setIsEditingName(true)}
              onBlur={saveName}
            />
            {shareCode && (
              <p
                className="text-sm text-neutral-500 dark:text-neutral-400"
                data-testid="share-code"
              >
                Share code: {shareCode}
              </p>
            )}
          </div>
        )}
      </div>
    </main>
  )
}

export default App
