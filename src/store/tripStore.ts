import { create } from 'zustand'
import type { Trip } from '@rv/shared'

interface TripStoreState {
  trips: Record<string, Trip>
  setTrip: (tripId: string, trip: Trip) => void
}

export const useTripStore = create<TripStoreState>((set) => ({
  trips: {},
  setTrip: (tripId, trip) =>
    set((state) => ({ trips: { ...state.trips, [tripId]: trip } })),
}))
