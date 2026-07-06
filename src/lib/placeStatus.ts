import { addDoc, collection, doc, updateDoc } from 'firebase/firestore'
import { db } from './firebase'

export type PlaceKind = 'activity' | 'restaurant'

const SUBCOLLECTION: Record<PlaceKind, string> = {
  activity: 'activities',
  restaurant: 'restaurants',
}

export async function markSelected(
  tripId: string,
  dayId: string,
  kind: PlaceKind,
  placeId: string,
) {
  await updateDoc(
    doc(db, 'trips', tripId, 'days', dayId, SUBCOLLECTION[kind], placeId),
    { status: 'selected' },
  )
}

export async function markDone(
  tripId: string,
  dayId: string,
  kind: PlaceKind,
  placeId: string,
  date: string,
  note: string,
) {
  const now = new Date().toISOString()
  const refPath = `trips/${tripId}/days/${dayId}/${SUBCOLLECTION[kind]}/${placeId}`

  await updateDoc(doc(db, refPath), {
    status: 'done',
    doneAt: now,
    ...(note ? { diaryNote: note } : {}),
  })

  await addDoc(collection(db, 'trips', tripId, 'log'), {
    date,
    refType: kind,
    refPath,
    ...(note ? { note } : {}),
    createdAt: now,
  })
}
