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
 * `writtenDays` must already be in trip-chronological order — grouping only
 * merges a run of *adjacent* same-coordinate days, not every day anywhere in
 * the trip that happens to share a coordinate. A loop itinerary revisiting
 * its own starting town, or a hub-and-spoke trip returning to a base
 * campsite, would otherwise collapse two unrelated visits into one
 * corridorStops doc whose linkedDayIds span non-contiguous days —
 * corridorReconciliation.ts treats each doc as a single contiguous block, so
 * reordering/removing that stop would move or delete days from two
 * unrelated points in the itinerary together.
 *
 * Every stop this produces is 'committed': it's already locked into a real
 * generated plan, not a rescan suggestion or a traveler-placed pin (phase 3).
 */
export function buildCorridorStopWrites(
  tripRef: DocumentReference,
  writtenDays: { ref: DocumentReference; day: TripDay }[],
): PendingWrite[] {
  const groups: { day: TripDay; dayIds: string[] }[] = []
  for (const { ref, day } of writtenDays) {
    const key = `${day.overnight.lat}|${day.overnight.lng}`
    const last = groups[groups.length - 1]
    const lastKey = last && `${last.day.overnight.lat}|${last.day.overnight.lng}`
    if (last && lastKey === key) {
      last.dayIds.push(ref.id)
      if (!last.day.highlightReason && day.highlightReason) {
        last.day = day
      }
    } else {
      groups.push({ day, dayIds: [ref.id] })
    }
  }

  return groups.map(({ day, dayIds }) => ({
    op: 'set',
    ref: tripRef.collection('corridorStops').doc(),
    data: corridorStopSchema.parse({
      name: day.overnight.name,
      lat: day.overnight.lat,
      lng: day.overnight.lng,
      country: day.overnight.country,
      why: day.highlightReason,
      status: 'committed',
      // This stop IS the plan, not research about it — see
      // corridorStopSchema.origin. A regeneration that replaces the plan
      // replaces these too.
      origin: 'plan',
      linkedDayIds: dayIds,
    }),
  }))
}

/**
 * Whether a stop is the traveler's own research rather than a description of
 * the plan being replaced.
 *
 * ABSENT origin reads as 'plan' deliberately. Every stop written before that
 * field existed carries nothing, and this predicate gates a deletion — so the
 * conservative reading keeps existing trips behaving exactly as they did,
 * rather than resurrecting stops nobody asked to keep. New curation is
 * stamped at every write site, so the protection applies from here on.
 */
export function isTravelerResearch(stop: { origin?: 'traveler' | 'plan' }): boolean {
  return stop.origin === 'traveler'
}
