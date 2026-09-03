import {
  collection,
  deleteField,
  doc,
  getDocs,
  writeBatch,
} from 'firebase/firestore'
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
  /**
   * What a rebuild would cost, so the confirmation can state it rather than
   * warn in general terms.
   *
   * Asked on 2026-08-31 — *"Does it have to warn? What does it have to
   * discard?"* — and the answer is now usually "nothing": a day whose
   * overnight survives the rebuild keeps its research (see
   * planSkeletonWrite), so a plain reorder discards no detail at all and
   * the panel has nothing to warn about.
   */
  reusing?: number
  discardingDetail?: number
  /**
   * Kept stops that could not be dated at all, because their country is
   * missing or malformed and a day's overnight must carry one.
   *
   * Reported as a rebuild that "seems to not respond" (2026-08-31): these
   * were dropped in silence, so the board went on counting them as stops
   * with no day while offering a button that could never give them one.
   * stopCountries repairs them; this is here so the next thing that cannot
   * be packed says so rather than disappearing.
   */
  undatable?: number
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
   * Where the route actually starts from — the van while the trip is
   * running, the trip's start point otherwise. Names the first day's drive,
   * which used to claim the start point however far away it was.
   */
  originName?: string
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

  // A stop with no country cannot become an overnight — the schema requires
  // a two-letter code — and writing a malformed day would surface a long way
  // from here.
  const usable = stops.filter((stop) => stop.country?.length === 2)
  const undatable = stops.length - usable.length
  if (usable.length === 0) return { skipped: 'no-stops', undatable }

  const packed = packStopsIntoDays({
    stops: usable,
    legs,
    maxDriveHoursPerDay: settings.maxDriveHoursPerDay,
  })
  if (packed.length === 0) return { skipped: 'no-stops' }
  if (packed.length > MAX_SKELETON_DAYS) return { skipped: 'too-many-days' }

  /**
   * Built in sequence, because a day cannot describe itself alone.
   *
   * Reported 2026-09-02, on a day in the Dolomites: *"Lüneburg, Tyskland →
   * Folgaride bike park · 42 km · 59 min"*. The distance and the time were
   * the real leg from the previous Italian stop; the NAME was the trip's
   * start point, a thousand kilometres north. `toTripDay` was handed an
   * index and a settings object and nothing about the day before it, so the
   * first day named `settings.startPoint` and every later one said the
   * literal placeholder "Previous stop".
   *
   * The same blindness put the first stop of the whole trip on a pure
   * driving day as its overnight (`lastStopBefore` returned `allStops[0]`),
   * which is how a night in Italy could be labelled with a town in Germany.
   */
  const days: TripDay[] = []
  let previousNight:
    | { name: string; lat: number; lng: number; country: string }
    | undefined
  packed.forEach((day, index) => {
    const built = toTripDay(day, index, settings, {
      previousNight,
      originName: input.originName ?? settings.startPoint.name,
    })
    days.push(built)
    previousNight = built.overnight
  })

  /**
   * The one question worth asking before writing on our own: would THIS
   * rebuild throw away research?
   *
   * It used to ask a much cruder one — "does any day carry detail at all" —
   * which was right when a rebuild deleted every day and every
   * subcollection. Once days are reused by overnight (see
   * planSkeletonWrite) that guard forbade the safe case along with the
   * unsafe one, and froze the day list on every generated trip: nothing
   * recomputed it from the board again, which is what left a traveler
   * pressing "Rebuild day list" by hand to keep their own itinerary current
   * (2026-08-31: "why do I need to rebuild the daylist?").
   *
   * Now the writer stands aside only when there is something to lose, and
   * that is exactly the case the button exists to let someone approve.
   */
  const write = planSkeletonWrite(existingDays, days)
  if (!input.rebuildOverDetail && write.discardingDetail > 0) {
    return { skipped: 'has-detail', undatable }
  }
  if (!input.rebuildOverDetail && sameAs(write, days)) {
    return { skipped: 'unchanged', undatable }
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
  return {
    days,
    stopIdsByDay,
    reusing: write.reuse.length,
    discardingDetail: write.discardingDetail,
    undatable,
  }
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
  // ABSENT MEANS READY — tripDaySchema says so in as many words, because
  // every day written before `detailStatus` existed carries its detail
  // already, and generation still omits the field entirely on a day it
  // detailed in the window (planPipeline writes it only when the day is
  // NOT detailed). Reading absent as "no detail" was therefore backwards
  // for exactly the days with the most research on them — harmless while
  // this only gated a button, and not harmless at all now that the writer
  // runs on its own (2026-08-31).
  return (
    day.detailStatus === undefined ||
    day.detailStatus === 'ready' ||
    day.detailStatus === 'generating' ||
    (day.filledSections?.length ?? 0) > 0
  )
}

function toTripDay(
  packed: PackedDay<CorridorStopWithId>,
  index: number,
  settings: Pick<TripSettings, 'startDate' | 'startPoint'>,
  context: {
    /** Where the night before was spent — absent only on the first day. */
    previousNight?: { name: string; lat: number; lng: number; country: string }
    /** Where the route sets off from. */
    originName: string
  },
): TripDay {
  // Where the night is spent: the last stop reached today, the stop we are
  // parked at, or — on a pure driving day — exactly where we slept last,
  // because a day that reaches no stop has not moved the night anywhere.
  const arriving = packed.stops[packed.stops.length - 1]
  const here = packed.parkedAt ?? arriving ?? context.previousNight

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
            // The place this drive actually leaves from: last night's
            // overnight, or where the route set off from on the first day.
            fromName: context.previousNight?.name ?? context.originName,
            toName: here.name,
            // Real Google kilometres, from the same legs the minutes come
            // from — see PackedDay.driveKm for why writing 0 here stopped
            // being survivable once this ran unattended.
            distanceKm: Math.round(packed.driveKm),
            durationMin: Math.round(packed.driveMinutes),
            slot: 'morning' as const,
          },
        }
      : {}),
    // The point of the whole thing: written cheap, filled in when opened.
    detailStatus: 'pending' as const,
  }
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
 *
 * Asked through the same matcher the WRITER uses, so the two agree on what
 * "the same day" means. Comparing overnight names directly was right while
 * every day was rewritten from scratch and wrong the moment days could be
 * reused: a reused day keeps the campsite name it was researched under
 * ("Camping Bavaria Riva") against a skeleton that names the stop ("Riva del
 * Garda"), which a name comparison calls a change forever — one pointless
 * rewrite per visit to the map.
 */
function sameAs(plan: SkeletonWritePlan, next: TripDay[]): boolean {
  if (plan.reuse.length !== next.length) return false
  if (plan.create.length > 0 || plan.removeIds.length > 0) return false
  return plan.reuse.every(
    ({ day, existing: was }) =>
      was.date === day.date &&
      was.type === day.type &&
      was.index === day.index,
  )
}

/** Adds `n` days to a YYYY-MM-DD string, in UTC — see dateShift.addDays. */
function addDays(date: string, n: number): string {
  const next = new Date(
    new Date(`${date}T00:00:00Z`).getTime() + n * 86_400_000,
  )
  return next.toISOString().slice(0, 10)
}


/**
 * Which existing day, if any, each rebuilt day should REUSE.
 *
 * Asked on 2026-08-31, and it is the right question: *"What does it have to
 * discard? Can it not just keep already generated days available, if they
 * would be done at a later point in time?"*
 *
 * It does not have to discard much. A day's researched activities and
 * restaurants belong to the PLACE it is spent in, not to the date it was
 * given — a lunch spot in Riva del Garda is still a lunch spot in Riva del
 * Garda when the day moves from the 2nd to the 4th. The old rebuild deleted
 * every day and every subcollection because it matched days by nothing at
 * all; matched by their overnight instead, most days survive a reorder
 * intact.
 *
 * Two keys, tried in order, because the two halves of a day's identity can
 * each go missing:
 *
 *  - the overnight's NAME, folded the way `normalizeStopName` folds a stop's
 *    — the usual case, and stable across a re-pack.
 *  - its COORDINATES at 2dp (≈1 km) — for the generated day whose overnight
 *    moved off the town centre onto an actual campsite and took the site's
 *    name with it ("Lillehammer Camping" against a stop called
 *    "Lillehammer"). The place is the same; only the label differs.
 *
 * Claimed greedily and at most once, so a basecamp's three nights match
 * three separate old days rather than all three claiming one.
 */
export interface SkeletonWritePlan {
  /** Existing days that keep their content, re-dated in place. */
  reuse: { id: string; dayIndex: number; day: TripDay; existing: TripDayWithId }[]
  /** Days with no counterpart to reuse. */
  create: { dayIndex: number; day: TripDay }[]
  /** Existing days nothing matched. Deleted, with their subcollections. */
  removeIds: string[]
  /**
   * How many of those carried research — the only number the traveler
   * actually needs before pressing a destructive-sounding button, and
   * usually zero.
   */
  discardingDetail: number
}

export function planSkeletonWrite(
  existing: TripDayWithId[],
  next: TripDay[],
): SkeletonWritePlan {
  const unclaimed = [...existing]
  const claim = (day: TripDay): TripDayWithId | undefined => {
    const byName = unclaimed.findIndex(
      (old) => nameKey(old.overnight?.name) === nameKey(day.overnight?.name),
    )
    const index =
      byName >= 0
        ? byName
        : unclaimed.findIndex(
            (old) => coordKey(anchorOf(old)) === coordKey(day.overnight),
          )
    if (index < 0) return undefined
    return unclaimed.splice(index, 1)[0]
  }

  const reuse: SkeletonWritePlan['reuse'] = []
  const create: SkeletonWritePlan['create'] = []
  next.forEach((day, dayIndex) => {
    const existingDay = claim(day)
    if (existingDay) reuse.push({ id: existingDay.id, dayIndex, day, existing: existingDay })
    else create.push({ dayIndex, day })
  })

  return {
    reuse,
    create,
    removeIds: unclaimed.map((day) => day.id),
    discardingDetail: unclaimed.filter(hasDetail).length,
  }
}

/**
 * Folded the way normalizeStopName folds a stop name — see its own note.
 *
 * Tolerates a day with no overnight at all. The schema requires one, so such
 * a document should not exist; this used to run only behind the
 * `has-detail` guard and now runs against every stored day on every render,
 * where one malformed document would take the whole board down with a
 * TypeError. Unmatchable rather than crashing — and since `hasDetail` reads
 * a day with no `detailStatus` as researched, an unmatched one makes the
 * automatic writer stand aside and ask rather than delete something nobody
 * here understands.
 */
function nameKey(name: string | undefined): string {
  if (!name) return '\u0000unmatchable'
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Where a stored day BELONGS, as opposed to where it sleeps.
 *
 * `townAnchor` is set the moment a traveler picks an alternative overnight
 * (see chooseOvernight), because a campsite can sit 15 km outside the town
 * the day is built around — and matching on the bed would make the day
 * unrecognisable to this function the instant someone chose one. The next
 * pass would then delete it and write a fresh one, taking the choice with
 * it. Reported 2026-09-02: "I went in to add alternative overnight stops…
 * It was not saved."
 *
 * The town is the identity; the bed is a decision about it.
 */
function anchorOf(day: TripDayWithId): { lat: number; lng: number } | undefined {
  return day.townAnchor ?? day.overnight
}

/** ≈1 km, the same grid quantisePosition uses for the route origin. */
function coordKey(point: { lat: number; lng: number } | undefined): string {
  if (!point || typeof point.lat !== 'number' || typeof point.lng !== 'number') {
    return '\u0000unmatchable'
  }
  return `${point.lat.toFixed(2)}|${point.lng.toFixed(2)}`
}

/**
 * What a reused day takes from the rebuild, and what it keeps.
 *
 * Takes: where it sits in the itinerary — `index`, `date`, `type`, and the
 * drive leg into it. Those are exactly what a re-pack decides.
 *
 * Keeps: its `overnight`, because the old one is the same place and may
 * carry a campsite suggestion or a free-camping rule the skeleton knows
 * nothing about; its `summary`, when the day has detail, because that
 * sentence describes the research rather than the route; and everything
 * else on the document — `detailStatus`, `filledSections`, `townAnchor`,
 * `sights` — by not being mentioned here at all. Its activities and
 * restaurants live in subcollections and are simply never touched.
 */
export function reusedDayFields(
  day: TripDay,
  existing: TripDayWithId,
): Record<string, unknown> {
  return {
    index: day.index,
    date: day.date,
    type: day.type,
    // A day that was researched keeps the sentence written about it; a bare
    // skeleton day takes the new one, which at least names where it goes.
    ...(hasDetail(existing) ? {} : { summary: day.summary }),
    // Deleted rather than left stale: a day that no longer has a drive into
    // it must not keep describing one from the plan before.
    drive: day.drive ?? deleteField(),
  }
}

/**
 * Writes the skeleton, REUSING every day whose overnight survives the
 * rebuild and deleting only the ones nothing matched.
 *
 * One batch, so the collection is never briefly half-rewritten — the same
 * reasoning as shiftPlanDates.
 *
 * It used to delete all of them, on the grounds that "their ids carry no
 * meaning here". That was true of a skeleton day nobody had opened and
 * false of everything else, and the cost was the warning the rebuild had to
 * show: researched activities and restaurants thrown away on every reorder,
 * and — because Firestore ids are what a diary entry's `refPath` points at
 * — any diary entry written against one of those places left dangling.
 * Matched by overnight, a reorder now keeps the research, keeps the diary,
 * and moves the dates. See planSkeletonWrite.
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
  const existingSnap = await getDocs(daysRef)
  const existing = existingSnap.docs.map(
    (day) => ({ id: day.id, ...day.data() }) as TripDayWithId,
  )
  const plan = planSkeletonWrite(existing, days)

  // Firestore does not cascade. Deleting a day document leaves its
  // activities, restaurants and overnight options addressable forever —
  // found 2026-08-25, and every rebuild until then orphaned them. Read only
  // for the days actually being removed now, which on a plain reorder is
  // none of them.
  const removed = existingSnap.docs.filter((day) =>
    plan.removeIds.includes(day.id),
  )
  const contents = await Promise.all(
    removed.map(async (day) => {
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
  for (const old of removed) batch.delete(old.ref)

  // The links, built as each day's ref is settled — a reused day keeps its
  // id, a new one gets one here, and both halves have to land in the same
  // batch or the board briefly shows days that no stop claims.
  const dayIdsByStop = new Map<string, string[]>()
  const linkStops = (dayIndex: number, dayId: string) => {
    for (const stopId of stopIdsByDay[dayIndex] ?? []) {
      dayIdsByStop.set(stopId, [...(dayIdsByStop.get(stopId) ?? []), dayId])
    }
  }
  for (const { id, dayIndex, day, existing: was } of plan.reuse) {
    batch.update(doc(daysRef, id), reusedDayFields(day, was))
    linkStops(dayIndex, id)
  }
  for (const { dayIndex, day } of plan.create) {
    const ref = doc(daysRef)
    batch.set(ref, day)
    linkStops(dayIndex, ref.id)
  }

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
    // `totalKm` is deliberately NOT written here. It used to be set to 0,
    // which was a placeholder standing in for "the skeleton does not know" —
    // survivable while a rebuild was a deliberate act on a board-built trip,
    // and a lie the moment this runs unattended on a generated one, where
    // the number is real and the family's share link renders it.
    // See PackedDay.driveKm: the per-day distances are known now, but the
    // whole-trip total belongs to whoever measured the whole trip.
    // The pacing advice described the day list that was here a moment ago —
    // which days were overloaded, and by how much. Rebuilt days have not
    // been checked, so keeping the old sentences would be asserting
    // something nobody measured. Reported 2026-08-31 as advice about days
    // eleven days behind the traveler; expiring them at render is the wider
    // fix (see livePacingWarnings), and this stops the rebuild carrying
    // them forward at all.
    'planMeta.pacingWarnings': [],
  })
  await batch.commit()
}
