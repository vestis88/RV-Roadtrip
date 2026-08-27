import { collection, doc, getDocs, writeBatch } from 'firebase/firestore'
import type { PlanMeta, TripDay, TripSettings } from '@rv/shared'
import { db } from './firebase'
import { packStopsIntoDays, type PackedDay } from './tripBudget'
import type { CorridorStopWithId } from '../hooks/useCorridorStops'
import type { TripDayWithId } from '../hooks/useTripDays'

/**
 * Days written straight from the board, for free.
 *
 * Requested 2026-08-23, in the same breath as keeping the overview: the
 * traveler wants sharing and the diary without being pushed through a full
 * generation to get them. Both read the `days` collection, so both need days
 * to EXIST — not to be detailed.
 *
 * And days can exist almost for nothing, because the board already holds
 * everything a skeleton needs:
 *
 *  - the locked stops, in route order, with their coordinates and country;
 *  - `routeLegs` — REAL Google driving times and distances from the
 *    Directions call the map is already making, which is why the legs
 *    written here carry no `estimated` flag: they are measured, not
 *    haversine guesses;
 *  - the trip's own dates.
 *
 * So this is a plain batched client write. `firestore.rules` allows it
 * (`match /days/{dayId}` grants members read and write), which means no
 * callable, no cold start, and nothing to wait for.
 *
 * The days it writes carry `detailStatus: 'pending'`, and that is the whole
 * trick: `DayDetailGate` already asks for a day's activities and restaurants
 * the moment that day is OPENED. A skeleton day is not a dead end — it fills
 * itself in when someone looks at it, and costs nothing until then.
 */

/** How many days a skeleton may write. A guard against a runaway pack. */
const MAX_SKELETON_DAYS = 120

export interface SkeletonDecision {
  /** Why nothing was written, when nothing was. */
  skipped?:
    | 'no-stops'
    | 'has-detail'
    | 'plan-busy'
    | 'no-dates'
    | 'unchanged'
    | 'too-many-days'
  days?: TripDay[]
  /**
   * Which stops landed on which day, by day index.
   *
   * Carried out of the packing because the stops have to be LINKED to the
   * days that get written — and without that the rebuild does not clear the
   * condition it is offered to fix. `stopsAddableToRoute` asks "is this a
   * kept stop with no day", so a rebuild that wrote days and left every
   * `linkedDayIds` empty left the "these days are from an earlier plan"
   * banner standing afterwards, which is indistinguishable from the rebuild
   * having done nothing (2026-08-26).
   */
  stopIdsByDay?: string[][]
}

/**
 * What the board's current state says the itinerary should be — or why it
 * should be left alone.
 *
 * Pure: no Firestore, no clock. Everything that decides whether to write is
 * a fact about the inputs, so the decision can be tested directly and the
 * writer below has no judgement of its own.
 */
export function planSkeleton(input: {
  stops: CorridorStopWithId[]
  legs: { durationMin: number; distanceKm: number }[]
  existingDays: TripDayWithId[]
  settings: Pick<
    TripSettings,
    'startDate' | 'endDate' | 'maxDriveHoursPerDay' | 'startPoint' | 'endPoint'
  >
  planMeta: Pick<PlanMeta, 'status'>
  /**
   * Rebuild even over days that carry researched detail.
   *
   * Never set by the automatic effect — only by the traveler pressing
   * "Rebuild day list", which says in as many words what it discards.
   *
   * Requested 2026-08-24: "My intention was to not have to interact in the
   * same way with the day view." The `has-detail` guard below is correct for
   * an effect that fires on its own, and it also meant that once a trip had
   * been generated AND a day opened, NOTHING recomputed the day list from
   * the board again — so the strip sat frozen, describing stops that had
   * since been removed. The guard stays; this is the door beside it.
   */
  rebuildOverDetail?: boolean
}): SkeletonDecision {
  const { stops, legs, existingDays, settings, planMeta } = input

  // A generation is authoritative while it runs; writing days underneath it
  // is how two writers end up interleaved in one collection.
  if (planMeta.status === 'pending' || planMeta.status === 'generating') {
    return { skipped: 'plan-busy' }
  }
  if (!settings.startDate || !settings.endDate) return { skipped: 'no-dates' }

  // Detail is expensive and was chosen by someone. A trip that has any
  // belongs to runReconcileCorridor, which knows how to move days without
  // discarding what is on them.
  if (!input.rebuildOverDetail && existingDays.some(hasDetail)) {
    return { skipped: 'has-detail' }
  }

  // A stop with no country cannot become an overnight — the schema requires
  // a two-letter code — and writing a malformed day would surface a long way
  // from here.
  const usable = stops.filter((stop) => stop.country?.length === 2)
  if (usable.length === 0) return { skipped: 'no-stops' }

  const packed = packStopsIntoDays({
    stops: usable,
    legs,
    maxDriveHoursPerDay: settings.maxDriveHoursPerDay,
  })
  if (packed.length === 0) return { skipped: 'no-stops' }
  if (packed.length > MAX_SKELETON_DAYS) return { skipped: 'too-many-days' }

  const days = packed.map((day, index) =>
    toTripDay(day, index, settings, usable),
  )
  if (!input.rebuildOverDetail && sameAs(existingDays, days)) {
    return { skipped: 'unchanged' }
  }
  // A parked day carries no `stops` of its own (the basecamp is on the first
  // of its nights), so `parkedAt` is what links the rest of them.
  const stopIdsByDay = packed.map((day) =>
    day.stops.length > 0
      ? day.stops.map((stop) => stop.id)
      : day.parkedAt
        ? [day.parkedAt.id]
        : [],
  )
  return { days, stopIdsByDay }
}

/**
 * Anything on this day that was paid for.
 *
 * `detailStatus` alone was not enough once sections could be filled one at a
 * time (2026-08-25). A day whose lunch was filled by hand is still
 * `pending` — correctly, since the rest was never asked for — and this
 * function's whole job is to stop the automatic writer rebuilding over work
 * somebody bought. Reading `filledSections` is what keeps that promise; it
 * is on the day document precisely so this can be answered without a
 * subcollection read, since planSkeleton runs on the client against day docs.
 */
function hasDetail(day: TripDayWithId): boolean {
  return (
    day.detailStatus === 'ready' ||
    day.detailStatus === 'generating' ||
    (day.filledSections?.length ?? 0) > 0
  )
}

function toTripDay(
  packed: PackedDay<CorridorStopWithId>,
  index: number,
  settings: Pick<TripSettings, 'startDate' | 'startPoint'>,
  allStops: CorridorStopWithId[],
): TripDay {
  // Where the night is spent: the last stop reached today, or the stop we
  // are parked at, or — on a pure driving day — wherever we last were.
  const arriving = packed.stops[packed.stops.length - 1]
  const here =
    packed.parkedAt ?? arriving ?? lastStopBefore(allStops, packed, index)
  const previous = index === 0 ? settings.startPoint.name : undefined

  return {
    index,
    date: addDays(settings.startDate, index),
    // A parked day is a rest day, which is also what keeps validatePacing's
    // one remaining invariant satisfied: its overnight matches the day
    // before it by construction.
    type: packed.parkedAt ? 'rest' : 'drive',
    overnight: {
      name: here?.name ?? settings.startPoint.name,
      lat: here?.lat ?? 0,
      lng: here?.lng ?? 0,
      country: here?.country ?? 'XX',
    },
    summary: summaryFor(packed, here?.name),
    ...(packed.driveMinutes > 0 && here
      ? {
          drive: {
            fromName: previous ?? 'Previous stop',
            toName: here.name,
            distanceKm: 0,
            durationMin: Math.round(packed.driveMinutes),
            slot: 'morning' as const,
          },
        }
      : {}),
    // The point of the whole thing: written cheap, filled in when opened.
    detailStatus: 'pending' as const,
  }
}

function lastStopBefore(
  allStops: CorridorStopWithId[],
  _packed: PackedDay<CorridorStopWithId>,
  index: number,
): CorridorStopWithId | undefined {
  return index === 0 ? undefined : allStops[0]
}

function summaryFor(
  packed: PackedDay<CorridorStopWithId>,
  name?: string,
): string {
  if (packed.parkedAt) return `Another night at ${packed.parkedAt.name}.`
  if (!name) return 'On the road.'
  const stop = packed.stops[packed.stops.length - 1]
  return stop?.why ? `${name}. ${stop.why}` : `On to ${name}.`
}

/**
 * Whether the itinerary already says this. Compared on the fields the
 * skeleton actually decides — date, order and where the night is — so a day
 * that has since gained an overnight CHOICE or a note is not rewritten over
 * a difference this function never made.
 */
function sameAs(existing: TripDayWithId[], next: TripDay[]): boolean {
  if (existing.length !== next.length) return false
  const byIndex = [...existing].sort((a, b) => a.index - b.index)
  return next.every((day, i) => {
    const was = byIndex[i]
    return (
      was &&
      was.date === day.date &&
      was.type === day.type &&
      was.overnight.name === day.overnight.name
    )
  })
}

/** Adds `n` days to a YYYY-MM-DD string, in UTC — see dateShift.addDays. */
function addDays(date: string, n: number): string {
  const next = new Date(
    new Date(`${date}T00:00:00Z`).getTime() + n * 86_400_000,
  )
  return next.toISOString().slice(0, 10)
}

/**
 * Writes the skeleton, replacing any dayless-and-detail-free itinerary that
 * was there before.
 *
 * One batch, so the collection is never briefly half-rewritten — the same
 * reasoning as shiftPlanDates. The old days are deleted rather than merged
 * because their ids carry no meaning here: nothing links to a skeleton day
 * that has never been opened.
 */
export async function writeSkeletonDays(
  tripId: string,
  days: TripDay[],
  /**
   * Which stops belong to which day, from the same decision that produced
   * `days` — see SkeletonDecision.stopIdsByDay. Omitted, the days are still
   * written but nothing is linked to them, which leaves the board saying the
   * kept stops have no day.
   */
  stopIdsByDay: string[][] = [],
): Promise<void> {
  const daysRef = collection(db, 'trips', tripId, 'days')
  const existing = await getDocs(daysRef)

  // Firestore does not cascade. Deleting a day document leaves its
  // activities, restaurants and overnight options addressable forever —
  // found 2026-08-25, and every rebuild until now orphaned them. The same
  // delete-the-contents-first shape applyDayCleanup and generatePlan's
  // writeGeneratedDays already use.
  const contents = await Promise.all(
    existing.docs.map(async (day) => {
      const [activities, restaurants, overnightOptions] = await Promise.all([
        getDocs(collection(day.ref, 'activities')),
        getDocs(collection(day.ref, 'restaurants')),
        getDocs(collection(day.ref, 'overnightOptions')),
      ])
      return [activities, restaurants, overnightOptions]
    }),
  )

  const batch = writeBatch(db)
  for (const snaps of contents) {
    for (const snap of snaps) {
      snap.docs.forEach((entry) => batch.delete(entry.ref))
    }
  }
  for (const old of existing.docs) batch.delete(old.ref)
  // The links, built as the day refs are created — the ids do not exist
  // until now, and both halves have to land in the same batch or the board
  // briefly shows days that no stop claims.
  const dayIdsByStop = new Map<string, string[]>()
  days.forEach((day, index) => {
    const ref = doc(daysRef)
    batch.set(ref, day)
    for (const stopId of stopIdsByDay[index] ?? []) {
      dayIdsByStop.set(stopId, [...(dayIdsByStop.get(stopId) ?? []), ref.id])
    }
  })
  // Every stop that was packed gets its new days; a stop that was packed
  // onto nothing is cleared rather than left pointing at a deleted day.
  const packedStopIds = new Set(stopIdsByDay.flat())
  for (const stopId of packedStopIds) {
    batch.update(doc(db, 'trips', tripId, 'corridorStops', stopId), {
      linkedDayIds: dayIdsByStop.get(stopId) ?? [],
    })
  }
  batch.update(doc(db, 'trips', tripId), {
    'planMeta.status': 'ready',
    'planMeta.totalKm': 0,
  })
  await batch.commit()
}
