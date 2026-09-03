import { doc, updateDoc } from 'firebase/firestore'
import type { OvernightStopCandidate, TripDay } from '@rv/shared'
import { db } from './firebase'

/**
 * Where this day sleeps, chosen by the traveler and written down.
 *
 * Reported 2026-09-02: *"I went in to add alternative overnight stops through
 * change overnight stops. It was not saved now that I went back to the same
 * day. I want the stops saved!!"*
 *
 * It was never saved, by design — the design of a model the app has left
 * behind. The picker's own comment said so: *"picking one doesn't patch
 * TripDay.overnight directly — that would leave every following day's drive
 * leg silently stale. Instead it submits a scoped replan."* So choosing a
 * campsite wrote a `planRequests` document and waited for a Claude pass to
 * rewrite the rest of the trip. Nothing changed on the day until that
 * finished — and with the API account out of credit it never finished at
 * all, so the choice evaporated in silence.
 *
 * The fear behind it is obsolete. Following days no longer hold a frozen
 * drive leg that a change here would strand: the day list is re-derived from
 * the board, and the legs come from the live Directions call the map is
 * already making. So this is what it always should have been — one field, on
 * one day, written immediately.
 *
 * **`townAnchor` is the load-bearing half.** The skeleton writer matches a
 * stored day to a rebuilt one by where it sleeps, so moving the overnight
 * onto a campsite 15 km outside the town would make the day unrecognisable
 * to the very code that preserves it — and the next pass would delete it and
 * write a fresh one, taking the choice with it. The town is the day's
 * identity; the bed is a decision about it. Recorded on the first change and
 * never overwritten, so the anchor stays the town however many campsites are
 * tried.
 */
export async function chooseOvernight(
  tripId: string,
  dayId: string,
  day: Pick<TripDay, 'overnight' | 'townAnchor'>,
  candidate: OvernightStopCandidate,
): Promise<void> {
  await updateDoc(doc(db, 'trips', tripId, 'days', dayId), {
    overnight: {
      name: candidate.name,
      lat: candidate.lat,
      lng: candidate.lng,
      country: candidate.country,
      type: candidate.type,
      ...(candidate.description
        ? { campsiteSuggestion: candidate.description }
        : {}),
    },
    // Only the FIRST time: after that the anchor is already the town, and
    // re-deriving it from the campsite currently chosen would let the day's
    // identity drift a few kilometres with every change.
    ...(day.townAnchor
      ? {}
      : {
          townAnchor: { lat: day.overnight.lat, lng: day.overnight.lng },
        }),
  })
}
