import { BrowserRouter, Route, Routes } from 'react-router-dom'
import AppShell from './screens/AppShell'
import { DayViewScreen } from './screens/DayViewScreen'
import { DiaryScreen } from './screens/DiaryScreen'
import { OverviewMapScreen } from './screens/OverviewMapScreen'
import { SetupScreen } from './screens/SetupScreen'

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<SetupScreen />} />
          <Route path="/map" element={<OverviewMapScreen />} />
          <Route path="/map/day/:dayId" element={<DayViewScreen />} />
          <Route path="/diary" element={<DiaryScreen />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

export default App
