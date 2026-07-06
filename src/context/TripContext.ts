import { createContext, useContext } from 'react'
import type { Trip } from '@rv/shared'

export interface TripContextValue {
  tripId: string
  trip: Trip
}

export const TripContext = createContext<TripContextValue | null>(null)

export function useTripContext(): TripContextValue {
  const value = useContext(TripContext)
  if (!value) {
    throw new Error('useTripContext must be used within a TripContext.Provider')
  }
  return value
}
