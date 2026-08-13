import { addDoc, collection, serverTimestamp } from 'firebase/firestore'
import type { Trip } from '@rv/shared'
import { db } from './firebase'

/**
 * The date a replan should treat as "now" for this trip.
 *
 * runReplan replans everything from `today` to the trip's end date, and
 * plans it as a trip that *starts* on `today` (see its remainderSettings).
 * That is right mid-trip and wrong before one: on a trip that hasn't started
 * yet, the calendar gap between today and the departure date got planned as
 * real travelling days. A three-night trip leaving tomorrow came back with
 * extra days dated before its own start, routed out of the start point
 * again, through the towns the preserved days already covered — the trip
 * both longer than it should be and doubling back on itself.
 *
 * Clamping to the start date leaves the mid-trip case untouched (today is
 * already the later of the two once travelling has begun) and makes the
 * pre-trip case mean what the traveler asked for: replan the trip, not the
 * days between now and it.
 */
export function replanFromDate(trip: Trip, today: string): string {
  return today > trip.settings.startDate ? today : trip.settings.startDate
}

/**
 * Shared by OverviewMapScreen's trip-wide "Request changes", Day View's
 * per-day variant and the overnight-stop picker — all three just submit a
 * replan planRequest with a different lockedDayIds set (every day the
 * traveler didn't ask to change survives untouched, per runReplan's
 * contract).
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
      today: replanFromDate(trip, today),
      completedRefPaths: [],
      remainingEndDate: trip.settings.endDate,
      remainingEndPoint: trip.settings.endPoint,
      changeRequestText,
      lockedDayIds,
    },
  })
}
