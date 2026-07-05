import { useState } from 'react'
import { doc, updateDoc } from 'firebase/firestore'
import { db } from './lib/firebase'
import { useTrip } from './hooks/useTrip'
import { useTripSession } from './hooks/useTripSession'
import { NotesScreen } from './screens/NotesScreen'
import { SettingsScreen } from './screens/SettingsScreen'

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
    <main className="min-h-svh bg-white px-4 py-6 dark:bg-neutral-900">
      <div className="mx-auto max-w-2xl text-center">
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
      {tripId && trip && (
        <>
          <SettingsScreen tripId={tripId} trip={trip} />
          <NotesScreen tripId={tripId} trip={trip} />
        </>
      )}
    </main>
  )
}

export default App
