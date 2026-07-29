import { deleteDoc, doc, updateDoc } from 'firebase/firestore'
import type { CorridorStopStatus } from '@rv/shared'
import { db } from './firebase'

export async function setCorridorStopStatus(
  tripId: string,
  stopId: string,
  status: CorridorStopStatus,
) {
  await updateDoc(doc(db, 'trips', tripId, 'corridorStops', stopId), { status })
}

export async function deleteCorridorStop(tripId: string, stopId: string) {
  await deleteDoc(doc(db, 'trips', tripId, 'corridorStops', stopId))
}
