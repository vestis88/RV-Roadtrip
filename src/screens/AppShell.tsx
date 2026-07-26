import { useState } from 'react'
import { Link, Outlet } from 'react-router-dom'
import { doc, updateDoc } from 'firebase/firestore'
import { APIProvider } from '@vis.gl/react-google-maps'
import type { Trip } from '@rv/shared'
import { db } from '../lib/firebase'
import { useTrip } from '../hooks/useTrip'
import { useTripSession } from '../hooks/useTripSession'
import { useTripDays } from '../hooks/useTripDays'
import { useExecutionMode } from '../hooks/useExecutionMode'
import { TripContext } from '../context/TripContext'
import { ExecutionModePrompt } from '../components/ExecutionModePrompt'

function ExecutionModeGate({ tripId, trip }: { tripId: string; trip: Trip }) {
  const { days } = useTripDays(tripId)
  const { behindKm, permissionDenied, replan, snoozeToday, submitManualPosition } =
    useExecutionMode(tripId, trip, days)

  return (
    <ExecutionModePrompt
      behindKm={behindKm}
      permissionDenied={permissionDenied}
      onReplan={() => replan().catch(console.error)}
      onSnooze={snoozeToday}
      onManualPosition={submitManualPosition}
    />
  )
}

function AppShell() {
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

  // Hoisted here (rather than per-screen) so the whole app shares a single
  // Maps JS bootstrap loader — separate APIProvider instances per screen
  // raced to call google.maps.importLibrary with different options, and the
  // loser's config (including the API key) was silently ignored.
  const mapsApiKey =
    (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined) ?? ''

  return (
    <APIProvider apiKey={mapsApiKey}>
      <main className="min-h-svh bg-white dark:bg-neutral-900">
        <div className="mx-auto max-w-2xl px-4 py-6 text-center">
          <h1 className="text-3xl font-semibold text-neutral-900 dark:text-white">
            RV Road Trip Planner
          </h1>
          {loading || !trip || !tripId ? (
            <p className="mt-2 text-neutral-500 dark:text-neutral-400">
              Loading trip…
            </p>
          ) : (
            <>
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
              <nav className="mt-4 flex flex-wrap justify-center gap-1 text-sm">
                <Link
                  to="/"
                  data-testid="nav-setup"
                  className="inline-flex min-h-11 items-center px-3 text-orange-700 underline dark:text-orange-400"
                >
                  Trip setup
                </Link>
                <Link
                  to="/map"
                  data-testid="nav-map"
                  className="inline-flex min-h-11 items-center px-3 text-orange-700 underline dark:text-orange-400"
                >
                  Map
                </Link>
                <Link
                  to="/diary"
                  data-testid="nav-diary"
                  className="inline-flex min-h-11 items-center px-3 text-orange-700 underline dark:text-orange-400"
                >
                  Diary
                </Link>
                <Link
                  to="/countries"
                  data-testid="nav-countries"
                  className="inline-flex min-h-11 items-center px-3 text-orange-700 underline dark:text-orange-400"
                >
                  Countries
                </Link>
              </nav>
            </>
          )}
        </div>
        {trip && tripId && (
          <TripContext.Provider value={{ tripId, trip }}>
            <ExecutionModeGate tripId={tripId} trip={trip} />
            <Outlet />
          </TripContext.Provider>
        )}
      </main>
    </APIProvider>
  )
}

export default AppShell
