import type { DocumentReference } from 'firebase-admin/firestore'
import { corridorStopSchema, type TripDay } from '@rv/shared'
import type { PendingWrite } from './firestoreBatch.js'

/**
 * Derives the trip's corridor — the sequence of distinct overnight stops —
 * from a freshly-written set of days, one corridorStops doc per distinct
 * overnight location. Consecutive rest days at the same stop merge into a
 * single entry (grouped by exact lat/lng — the same numeric value is reused
 * verbatim for every day at that stop, never recomputed, so exact-match
 * grouping carries no floating-point drift risk).
 *
 * Every stop this produces is 'committed': it's already locked into a real
 * generated plan, not a rescan suggestion or a traveler-placed pin (phase 3).
 */
export function buildCorridorStopWrites(
  tripRef: DocumentReference,
  writtenDays: { ref: DocumentReference; day: TripDay }[],
): PendingWrite[] {
  const groups = new Map<string, { day: TripDay; dayIds: string[] }>()
  for (const { ref, day } of writtenDays) {
    const key = `${day.overnight.lat}|${day.overnight.lng}`
    const existing = groups.get(key)
    if (existing) {
      existing.dayIds.push(ref.id)
      if (!existing.day.highlightReason && day.highlightReason) {
        existing.day = day
      }
    } else {
      groups.set(key, { day, dayIds: [ref.id] })
    }
  }

  return Array.from(groups.values()).map(({ day, dayIds }) => ({
    op: 'set',
    ref: tripRef.collection('corridorStops').doc(),
    data: corridorStopSchema.parse({
      name: day.overnight.name,
      lat: day.overnight.lat,
      lng: day.overnight.lng,
      country: day.overnight.country,
      why: day.highlightReason,
      status: 'committed',
      linkedDayIds: dayIds,
    }),
  }))
}
