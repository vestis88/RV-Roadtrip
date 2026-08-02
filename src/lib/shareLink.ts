import { httpsCallable } from 'firebase/functions'
import { functions } from './firebase'

/**
 * Returns the trip's existing view-only link if it has one, minting a token
 * only when it doesn't — see createShareTokenForTrip in
 * functions/src/shareTokens.ts for why this is idempotent.
 */
export async function createTripShareLink(tripId: string): Promise<string> {
  const call = httpsCallable<{ tripId: string }, { token: string }>(
    functions,
    'createTripShareLink',
  )
  const { data } = await call({ tripId })
  return data.token
}

export async function revokeTripShareLink(tripId: string): Promise<void> {
  const call = httpsCallable<{ tripId: string }, { revoked: number }>(
    functions,
    'revokeTripShareLink',
  )
  await call({ tripId })
}
