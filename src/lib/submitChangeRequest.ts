import { addDoc, collection, serverTimestamp } from 'firebase/firestore'
import type { Trip } from '@rv/shared'
import { db } from './firebase'

/**
 * Shared by OverviewMapScreen's trip-wide "Request changes" and Day View's
 * per-day variant — both just submit a replan planRequest with a different
 * lockedDayIds set (every day the traveler didn't ask to change survives
 * untouched, per runReplan's contract).
 */
export async function submitPlanChangeRequest(
  tripId: string,
  trip: Trip,
  changeRequestText: string,
  lockedDayIds: string[],
) {
  const today = new Date().toISOString().slice(0, 10)
  await addDoc(collection(db, 'planRequests'), {
    tripId,
    kind: 'replan',
    status: 'pending',
    createdAt: serverTimestamp(),
    replanContext: {
      currentLocation: {
        lat: trip.settings.startPoint.lat,
        lng: trip.settings.startPoint.lng,
      },
      today,
      completedRefPaths: [],
      remainingEndDate: trip.settings.endDate,
      remainingEndPoint: trip.settings.endPoint,
      changeRequestText,
      lockedDayIds,
    },
  })
}
