import { doc, updateDoc } from 'firebase/firestore'
import type { TripSettings } from '@rv/shared'
import { db } from './firebase'

export async function updateTripSettings(
  tripId: string,
  partial: Partial<TripSettings>,
) {
  const updates: Record<string, unknown> = { 'planMeta.status': 'stale' }
  for (const [key, value] of Object.entries(partial)) {
    updates[`settings.${key}`] = value
  }
  await updateDoc(doc(db, 'trips', tripId), updates)
}
