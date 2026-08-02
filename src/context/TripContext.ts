import { createContext, useContext } from 'react'
import type { Trip } from '@rv/shared'

export interface TripContextValue {
  tripId: string
  trip: Trip
  /**
   * The signed-in account. Needed by anything stored per-traveler rather
   * than per-trip — the country research brief (users/{uid}/preferences)
   * is the first of those, and it deliberately outlives any one trip.
   */
  uid: string | null
}

export const TripContext = createContext<TripContextValue | null>(null)

export function useTripContext(): TripContextValue {
  const value = useContext(TripContext)
  if (!value) {
    throw new Error('useTripContext must be used within a TripContext.Provider')
  }
  return value
}
