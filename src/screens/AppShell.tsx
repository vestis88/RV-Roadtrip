import { useEffect, useState } from 'react'
import { Link, Outlet, useLocation } from 'react-router-dom'
import { doc, updateDoc } from 'firebase/firestore'
import { APIProvider } from '@vis.gl/react-google-maps'
import type { Trip } from '@rv/shared'
import { db } from '../lib/firebase'
import { useTrip } from '../hooks/useTrip'
import { useTripSession } from '../hooks/useTripSession'
import { useMyTrips } from '../hooks/useMyTrips'
import { useTripDays } from '../hooks/useTripDays'
import { useExecutionMode } from '../hooks/useExecutionMode'
import { TripContext } from '../context/TripContext'
import { ExecutionModePrompt } from '../components/ExecutionModePrompt'
import { TripSwitcher } from '../components/TripSwitcher'
import { deleteTrip as deleteTripCallable } from '../lib/deleteTrip'

function ExecutionModeGate({ tripId, trip }: { tripId: string; trip: Trip }) {
  const { days } = useTripDays(tripId)
  const {
    behindKm,
    permissionDenied,
    replan,
    snoozeToday,
    submitManualPosition,
  } = useExecutionMode(tripId, trip, days)

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

const NAV_ITEMS = [
  { to: '/', testId: 'nav-setup', label: 'Trip setup' },
  { to: '/map', testId: 'nav-map', label: 'Map' },
  { to: '/diary', testId: 'nav-diary', label: 'Diary' },
  { to: '/countries', testId: 'nav-countries', label: 'Countries' },
] as const

/** Trip setup lives at the root path, so it only matches exactly; the others
 * stay highlighted across their nested routes (e.g. /map/day/:dayId). */
function isActiveRoute(pathname: string, to: string): boolean {
  return to === '/' ? pathname === '/' : pathname.startsWith(to)
}

function AppShell() {
  const { tripId, uid, switchTrip, startNewTrip } = useTripSession()
  const { trip, loading } = useTrip(tripId)
  const myTrips = useMyTrips(uid)
  const [nameDraft, setNameDraft] = useState('')
  const [isEditingName, setIsEditingName] = useState(false)
  const [creatingTrip, setCreatingTrip] = useState(false)
  const location = useLocation()
  const isSetupPage = location.pathname === '/'

  async function handleCreateTrip() {
    setCreatingTrip(true)
    try {
      await startNewTrip(
        trip ? { settings: trip.settings, notesFreeText: trip.notes.freeText } : undefined,
      )
    } catch (error) {
      console.error('startNewTrip failed', error)
    } finally {
      setCreatingTrip(false)
    }
  }

  async function handleDeleteTrip(idToDelete: string) {
    await deleteTripCallable(idToDelete)
    if (idToDelete !== tripId) return
    // Deleted the active trip — land somewhere real rather than an
    // AppShell stuck loading a trip that no longer exists. Prefer a
    // remaining trip over minting a fresh one, using the switcher's own
    // already-fetched list (its own onSnapshot will drop the deleted trip
    // shortly after, but that race shouldn't decide what happens next).
    const remaining = myTrips.filter((t) => t.id !== idToDelete)
    if (remaining.length > 0) {
      switchTrip(remaining[0].id)
    } else {
      await startNewTrip()
    }
  }

  if (trip && !isEditingName && nameDraft !== trip.meta.name) {
    setNameDraft(trip.meta.name)
  }

  // The browser tab title never reflected which trip was actually open —
  // switching trips, or a shared trip getting renamed by another traveler,
  // left it stuck on the static index.html default forever. Reruns on
  // every trip.meta.name change, not just once on load, so switching trips
  // (or the active trip being renamed) keeps it current rather than going
  // stale after the first paint.
  useEffect(() => {
    document.title = trip?.meta.name
      ? `${trip.meta.name} · RV Road Trip Planner`
      : 'RV Road Trip Planner'
  }, [trip?.meta.name])

  // iOS Safari resizes the *visual* viewport for the on-screen keyboard
  // without resizing the layout viewport, so its native "scroll the focused
  // field into view" behavior — which targets the layout/document scroll —
  // doesn't reliably land inside the nested `overflow-y-auto` pane below
  // (needed for h-svh's fixed-height flex column, see its own comment).
  // Reported symptom: focusing a field (e.g. Settings' "Finish point" via
  // PlaceAutocompleteInput) opens the keyboard with the field left off the
  // top of the visible area, only found by scrolling back up manually.
  // Re-scrolling the actually-focused element once the visual viewport
  // settles after the keyboard animation fixes it for any field, not just
  // that one.
  //
  // Only once per newly-focused element (lastScrolledRef), not on every
  // resize: PlaceAutocompleteElement expands into its own full-screen
  // mobile suggestion overlay once the traveler starts typing, which fires
  // a further wave of visualViewport resizes on its own. Re-running this on
  // every one of those fought the overlay for scroll position — reported as
  // the screen "going black" (Google's own overlay, momentarily off-screen
  // mid fight) requiring a manual scroll up to recover. The field/keyboard
  // case is still exactly one resize per focus, so this doesn't lose the
  // original fix — it just stops repeating it against the same element.
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    let lastScrolled: Element | null = null
    function scrollFocusedFieldIntoView() {
      // The Places autocomplete fields (PlaceAutocompleteInput) render
      // Google's PlaceAutocompleteElement web component, whose actual
      // <input> lives inside an open shadow root — document.activeElement
      // only ever reports the shadow host in that case, so this walks down
      // to the real focused element instead of stopping there.
      let active: Element | null = document.activeElement
      while (active?.shadowRoot?.activeElement) {
        active = active.shadowRoot.activeElement
      }
      if (active instanceof HTMLElement && active !== lastScrolled) {
        lastScrolled = active
        active.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }
    }
    viewport.addEventListener('resize', scrollFocusedFieldIntoView)
    return () =>
      viewport.removeEventListener('resize', scrollFocusedFieldIntoView)
  }, [])

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

  const navLinks = NAV_ITEMS.map(({ to, testId, label }) => {
    const active = isActiveRoute(location.pathname, to)
    return (
      <Link
        key={to}
        to={to}
        data-testid={testId}
        aria-current={active ? 'page' : undefined}
        className={`nav-pill ${active ? 'nav-pill-active' : 'nav-pill-idle'}`}
      >
        {label}
      </Link>
    )
  })

  return (
    <APIProvider apiKey={mapsApiKey}>
      {/* A fixed h-svh (not min-h-svh) so this flex column has a definite
       * height for its flex-1 content pane to actually fill — Chromium will
       * grow a flex-1 child to fill a min-height container's leftover space,
       * but WebKit/Safari (i.e. real iPhones) does not reliably do the same,
       * so the map/day-view screens' own `h-full` resolved to ~0px there and
       * Google Maps silently rendered nothing. Content taller than one
       * viewport still scrolls fine via the inner overflow-y-auto pane. */}
      <main className="surface flex h-svh flex-col">
        {loading || !trip || !tripId ? (
          <div className="mx-auto max-w-2xl px-4 py-10 text-center">
            <h1 className="text-3xl font-semibold tracking-tight text-neutral-900 dark:text-white">
              RV Road Trip Planner
            </h1>
            <p className="mt-2 text-neutral-500 dark:text-neutral-400">
              Loading trip…
            </p>
          </div>
        ) : isSetupPage ? (
          <div className="border-b border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
            <div className="mx-auto max-w-2xl px-4 py-6 text-center">
              <h1 className="text-3xl font-semibold tracking-tight text-neutral-900 dark:text-white">
                RV Road Trip Planner
              </h1>
              <div className="mt-4 space-y-2">
                <input
                  className="field text-center text-lg font-medium"
                  data-testid="trip-name-input"
                  placeholder="Name your trip"
                  value={nameDraft}
                  onChange={(event) => setNameDraft(event.target.value)}
                  onFocus={() => setIsEditingName(true)}
                  onBlur={saveName}
                />
                <TripSwitcher
                  trips={myTrips}
                  currentTripId={tripId}
                  onSwitch={switchTrip}
                  onCreate={() => handleCreateTrip().catch(console.error)}
                  onDelete={handleDeleteTrip}
                  creating={creatingTrip}
                />
              </div>
              <nav className="mt-4 flex flex-wrap justify-center gap-1 rounded-full bg-neutral-100 p-1 dark:bg-neutral-800/60">
                {navLinks}
              </nav>
            </div>
          </div>
        ) : (
          <nav
            data-testid="compact-nav"
            className="flex flex-wrap justify-center gap-1 border-b border-neutral-200 bg-white px-2 py-1.5 dark:border-neutral-800 dark:bg-neutral-900"
          >
            {navLinks}
          </nav>
        )}
        {trip && tripId && (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <TripContext.Provider value={{ tripId, trip }}>
              <ExecutionModeGate tripId={tripId} trip={trip} />
              <Outlet />
            </TripContext.Provider>
          </div>
        )}
      </main>
    </APIProvider>
  )
}

export default AppShell
