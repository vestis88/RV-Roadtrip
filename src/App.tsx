import { BrowserRouter, Route, Routes } from 'react-router-dom'
import AppShell from './screens/AppShell'
import { CountriesScreen } from './screens/CountriesScreen'
import { CountryDetailScreen } from './screens/CountryDetailScreen'
import { DayViewScreen } from './screens/DayViewScreen'
import { DiaryScreen } from './screens/DiaryScreen'
import { OverviewMapScreen } from './screens/OverviewMapScreen'
import { SetupScreen } from './screens/SetupScreen'
import { SharedTripScreen } from './screens/SharedTripScreen'

function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Outside AppShell deliberately: the shell signs the visitor in
            (useTripSession) and provides a trip context, and a relative
            following a view-only link must get neither — no account, no
            membership, nothing that could write to the trip. */}
        <Route path="/share/:token" element={<SharedTripScreen />} />
        <Route element={<AppShell />}>
          <Route path="/" element={<SetupScreen />} />
          <Route path="/map" element={<OverviewMapScreen />} />
          <Route path="/map/day/:dayId" element={<DayViewScreen />} />
          <Route path="/diary" element={<DiaryScreen />} />
          <Route path="/countries" element={<CountriesScreen />} />
          <Route path="/countries/:code" element={<CountryDetailScreen />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

export default App
