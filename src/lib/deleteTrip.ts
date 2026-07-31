import { httpsCallable } from 'firebase/functions'
import { functions } from './firebase'

export async function deleteTrip(tripId: string): Promise<void> {
  const call = httpsCallable<{ tripId: string }, { deleted: boolean }>(
    functions,
    'deleteTrip',
  )
  await call({ tripId })
}
