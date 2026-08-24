import { collection, doc, getDocs, writeBatch } from 'firebase/firestore'
import type { TripDay } from '@rv/shared'
import { db } from './firebase'
import { setCorridorStopStatus } from './corridorStopActions'
import type { CorridorStopWithId } from '../hooks/useCorridorStops'
import type { TripDayWithId } from '../hooks/useTripDays'

/**
 * Days left behind by a stop that is no longer in the route.
 *
 * Reported 2026-08-24: *"I've removed stops previously locked in (they were
 * likely part of a previous full generation), but the items are still in the
 * day list."* — and, in the same breath, *"the list of day plans on top does
 * not seem to update dynamically."*
 *
 * Both are the same defect, and it is a gap between two mechanisms rather
 * than a bug inside either:
 *
 *  - **Unlocking or rejecting a stop only writes `status`.** See
 *    corridorStopActions. The day it owns, and the stop's own
 *    `linkedDayIds`, are untouched — so the day survives the stop that was
 *    the reason for it.
 *  - **The skeleton writer will not clean up after it.** `planSkeleton`
 *    refuses to touch a trip where any day carries detail, which is correct:
 *    that detail was paid for and belongs to `runReconcileCorridor`. But it
 *    means that for a trip that has ever been generated and opened, NOTHING
 *    rewrites the day list in response to the board.
 *
 * The result is a day strip frozen at whatever the last full generation
 * said, quietly diverging from the stops it claims to describe.
 *
 * There is a third consequence, worse than either and invisible until you
 * try: `reconcileCorridor` hard-throws when the committed stops' linked days
 * do not cover every day in the trip. A stop rejected from the board leaves
 * exactly that mismatch, so "Edit route" then fails on a trip that looks
 * perfectly fine. Removing the days with the stop is what keeps that
 * invariant true, which is why this is a fix and not a tidy-up.
 */

/**
 * Days whose every owner has left the route.
 *
 * The link direction matters, and getting it backwards would be
 * catastrophic: this is NOT "days nobody links to". Skeleton days
 * (writeSkeletonDays) are linked by nobody at all — no stop records them —
 * and treating those as stale would delete the itinerary of every trip that
 * never ran a full generation.
 *
 * So a day is stale only when it IS claimed, and every stop claiming it has
 * since left the route. `committed` and `locked` are the two in-route
 * statuses; `candidate` (unlocked) and `rejected` are not.
 */
export function staleDays(
  stops: CorridorStopWithId[],
  days: TripDayWithId[],
): TripDayWithId[] {
  const claimedBy = new Map<string, CorridorStopWithId[]>()
  for (const stop of stops) {
    for (const dayId of stop.linkedDayIds ?? []) {
      const held = claimedBy.get(dayId)
      if (held) held.push(stop)
      else claimedBy.set(dayId, [stop])
    }
  }

  return days.filter((day) => {
    const owners = claimedBy.get(day.id)
    if (!owners || owners.length === 0) return false
    return !owners.some(
      (stop) => stop.status === 'committed' || stop.status === 'locked',
    )
  })
}

export interface DayCleanupPlan {
  /** Day documents to delete, with their activities and restaurants. */
  removeDayIds: string[]
  /** Days that keep existing but move, as `{ id, index, date }`. */
  renumber: { id: string; index: number; date: string }[]
  /**
   * Days that must stop being rest days. A `rest` day is only valid directly
   * after a day at the same overnight — an invariant `validatePacing` still
   * throws on — and deleting the day in front of one breaks it.
   */
  demoteToDrive: string[]
  /** Stops whose `linkedDayIds` must drop the removed days. */
  unlinkStopIds: string[]
}

/**
 * What removing these days means for everything around them.
 *
 * Pure — no Firestore, no clock — for the same reason `planSkeleton` is: the
 * decision is a fact about the inputs, so it can be tested directly and the
 * writer below gets no judgement of its own.
 *
 * Dates are re-derived from `startDate` rather than shuffled up, so the
 * itinerary stays contiguous from day one. That is the same rule
 * `skeletonDays.toTripDay` uses, and having two different ideas of what
 * "day 4's date" means is how a plan ends up with a gap in it.
 */
export function planDayCleanup(input: {
  removeDayIds: string[]
  days: TripDayWithId[]
  stops: CorridorStopWithId[]
  startDate: string
}): DayCleanupPlan {
  const { days, stops, startDate } = input
  const removing = new Set(input.removeDayIds)
  const empty: DayCleanupPlan = {
    removeDayIds: [],
    renumber: [],
    demoteToDrive: [],
    unlinkStopIds: [],
  }
  if (removing.size === 0 || !startDate) return empty

  const ordered = [...days].sort((a, b) => a.index - b.index)
  const survivors = ordered.filter((day) => !removing.has(day.id))

  const renumber: { id: string; index: number; date: string }[] = []
  const demoteToDrive: string[] = []
  survivors.forEach((day, index) => {
    const date = addDays(startDate, index)
    if (day.index !== index || day.date !== date) {
      renumber.push({ id: day.id, index, date })
    }
    // The rest-day invariant, checked against the NEW neighbour rather than
    // the old one. A rest day whose predecessor was just deleted is now
    // parked somewhere it never arrived at.
    const previous = survivors[index - 1]
    if (
      day.type === 'rest' &&
      (!previous || previous.overnight.name !== day.overnight.name)
    ) {
      demoteToDrive.push(day.id)
    }
  })

  const unlinkStopIds = stops
    .filter((stop) => (stop.linkedDayIds ?? []).some((id) => removing.has(id)))
    .map((stop) => stop.id)

  return {
    removeDayIds: [...removing],
    renumber,
    demoteToDrive,
    unlinkStopIds,
  }
}

/**
 * Applies the plan.
 *
 * One batch, so the itinerary is never briefly half-renumbered — the same
 * reasoning as writeSkeletonDays and shiftPlanDates. Subcollections are read
 * first because Firestore does not cascade: deleting a day document leaves
 * its activities and restaurants addressable forever, which is the leak
 * `generatePlan.writeGeneratedDays` already deletes around.
 */
export async function applyDayCleanup(
  tripId: string,
  plan: DayCleanupPlan,
  stops: CorridorStopWithId[],
): Promise<void> {
  if (plan.removeDayIds.length === 0) return
  const daysRef = collection(db, 'trips', tripId, 'days')

  const contents = await Promise.all(
    plan.removeDayIds.map(async (dayId) => {
      const [activities, restaurants, overnightOptions] = await Promise.all([
        getDocs(collection(daysRef, dayId, 'activities')),
        getDocs(collection(daysRef, dayId, 'restaurants')),
        getDocs(collection(daysRef, dayId, 'overnightOptions')),
      ])
      return { dayId, activities, restaurants, overnightOptions }
    }),
  )

  const batch = writeBatch(db)
  for (const { dayId, activities, restaurants, overnightOptions } of contents) {
    for (const snap of [activities, restaurants, overnightOptions]) {
      snap.docs.forEach((entry) => batch.delete(entry.ref))
    }
    batch.delete(doc(daysRef, dayId))
  }
  for (const { id, index, date } of plan.renumber) {
    batch.update(doc(daysRef, id), { index, date })
  }
  for (const id of plan.demoteToDrive) {
    batch.update(doc(daysRef, id), { type: 'drive' satisfies TripDay['type'] })
  }

  const removing = new Set(plan.removeDayIds)
  const byId = new Map(stops.map((stop) => [stop.id, stop]))
  for (const stopId of plan.unlinkStopIds) {
    const stop = byId.get(stopId)
    if (!stop) continue
    batch.update(doc(db, 'trips', tripId, 'corridorStops', stopId), {
      linkedDayIds: (stop.linkedDayIds ?? []).filter((id) => !removing.has(id)),
    })
  }
  await batch.commit()
}

/**
 * Taking a stop out of the route, days and all.
 *
 * The one entry point the board uses for both "Unlock" and "Not interested",
 * because the difference between those two is what `status` becomes and
 * nothing else — and the day has to go either way. Writing the status
 * without this was the whole defect.
 *
 * Status first, deliberately. If the cleanup fails halfway the stop is at
 * least out of the route and the leftover day is visible as stale (see
 * staleDays), which is recoverable. The other order leaves days deleted for
 * a stop still claiming to be in the route, which is not.
 */
export async function removeStopFromRoute(input: {
  tripId: string
  stop: CorridorStopWithId
  stops: CorridorStopWithId[]
  days: TripDayWithId[]
  startDate: string
  nextStatus: 'candidate' | 'rejected'
}): Promise<void> {
  const { tripId, stop, stops, days, startDate, nextStatus } = input
  await setCorridorStopStatus(tripId, stop.id, nextStatus)

  const plan = planDayCleanup({
    removeDayIds: (stop.linkedDayIds ?? []).filter((dayId) =>
      days.some((day) => day.id === dayId),
    ),
    days,
    stops,
    startDate,
  })
  await applyDayCleanup(tripId, plan, stops)
}

/** Adds `n` days to a YYYY-MM-DD string, in UTC — see dateShift.addDays. */
function addDays(date: string, n: number): string {
  const next = new Date(
    new Date(`${date}T00:00:00Z`).getTime() + n * 86_400_000,
  )
  return next.toISOString().slice(0, 10)
}
