import { useTripContext } from '../context/TripContext'
import { NotesScreen } from './NotesScreen'
import { SettingsScreen } from './SettingsScreen'

export function SetupScreen() {
  const { tripId, trip } = useTripContext()
  return (
    <>
      <SettingsScreen tripId={tripId} trip={trip} />
      <NotesScreen tripId={tripId} trip={trip} />
    </>
  )
}

export default SetupScreen
