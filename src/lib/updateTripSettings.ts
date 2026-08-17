import { doc, updateDoc } from 'firebase/firestore'
import type { PlanStatus, TripSettings } from '@rv/shared'
import { db } from './firebase'
import { NON_INVALIDATING_SETTINGS } from './detailWindow'

/**
 * `currentStatus` decides whether this edit needs to invalidate anything:
 * only a `ready` plan can go stale — one that's never been generated
 * ('idle'), failed ('error'), or is already mid-generation has nothing
 * settings changes could invalidate. Reported as a brand-new trip
 * permanently reading "stale"/"Re-plan trip" the moment any setting (even
 * one inherited from a previous trip) got written, which also hid
 * ExploreMapScreen entirely — OverviewMapScreen only shows it for
 * `status === 'idle'`, so this one wrong write made the initial-plan
 * trigger disappear.
 */
export async function updateTripSettings(
  tripId: string,
  partial: Partial<TripSettings>,
  currentStatus: PlanStatus,
) {
  const updates: Record<string, unknown> = {}
  // And not every edit invalidates anything even then — see
  // NON_INVALIDATING_SETTINGS. An edit touching only those must leave a
  // finished plan finished, or moving a slider puts "Re-plan trip" in front
  // of the traveler and asks them to pay for a regeneration that would
  // change nothing they can see.
  const invalidates = Object.keys(partial).some(
    (key) => !NON_INVALIDATING_SETTINGS.has(key),
  )
  if (currentStatus === 'ready' && invalidates) {
    updates['planMeta.status'] = 'stale'
  }
  for (const [key, value] of Object.entries(partial)) {
    updates[`settings.${key}`] = value
  }
  await updateDoc(doc(db, 'trips', tripId), updates)
}
