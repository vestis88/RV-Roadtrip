import { BrowserRouter, Outlet, Route, Routes } from 'react-router-dom'
import { AccessGate } from './components/AccessGate'
import AppShell from './screens/AppShell'
import { CountriesScreen } from './screens/CountriesScreen'
import { CountryDetailScreen } from './screens/CountryDetailScreen'
import { DayViewScreen } from './screens/DayViewScreen'
import { DiaryScreen } from './screens/DiaryScreen'
import { OverviewMapScreen } from './screens/OverviewMapScreen'
import { SetupScreen } from './screens/SetupScreen'
import { SharedTripScreen } from './screens/SharedTripScreen'

/**
 * A layout route rather than a wrapper around the whole <Routes>, so the
 * share link can sit outside it as a plain sibling. Everything nested under
 * here needs an invited account; the one route that must not is the one
 * whose entire purpose is to work without one.
 */
function GatedRoutes() {
  return (
    <AccessGate>
      <Outlet />
    </AccessGate>
  )
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Outside both the gate and AppShell, deliberately: the shell signs
            the visitor in (useTripSession) and provides a trip context, and
            the gate demands an invited Google account. A relative following
            a view-only link must get neither — no account, no membership,
            nothing that could write to the trip. */}
        <Route path="/share/:token" element={<SharedTripScreen />} />
        <Route element={<GatedRoutes />}>
          <Route element={<AppShell />}>
            <Route path="/" element={<SetupScreen />} />
            <Route path="/map" element={<OverviewMapScreen />} />
            <Route path="/map/day/:dayId" element={<DayViewScreen />} />
            <Route path="/diary" element={<DiaryScreen />} />
            <Route path="/countries" element={<CountriesScreen />} />
            <Route path="/countries/:code" element={<CountryDetailScreen />} />
          </Route>
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

export default App
