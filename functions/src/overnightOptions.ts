import { getFirestore, type DocumentReference } from 'firebase-admin/firestore'
import { overnightStopCandidateSchema } from '@rv/shared'
import type { LatLng, OvernightStopCandidate, TripDay } from '@rv/shared'
import { commitInChunks, type PendingWrite } from './firestoreBatch.js'
import { findNearbyCampsites } from './placesApi.js'
import {
  nearestOsmPlaces,
  osmPlaceToCandidate,
  searchOvernightOsmAlongRoute,
  type OsmOvernightPlace,
} from './overpassApi.js'

/**
 * How many of each kind every day gets by default. Three of one kind is
 * already more than anyone compares in a picker, and the three kinds are the
 * real choice being offered — campsite, stellplatz, or free.
 */
export const OPTIONS_PER_KIND = 3

/** One day's worth of "where could we sleep here", as resolved up front. */
export interface DayOvernightQuery {
  /** Stable id for the caller to key results by — the Firestore day id. */
  key: string
  /** The town the day is about, NOT wherever it ends up sleeping. */
  near: LatLng
  country: string
}

/**
 * Overnight options for every day of a trip, resolved in one pass
 * (implemented 2026-08-12).
 *
 * Until now these were resolved lazily, per day, only when someone opened
 * "Change overnight" — because doing it for every day meant, per day, an
 * Overpass request and one or two Claude calls with web search. Over sixty
 * days that is not a cost question, it is an impossibility: a single one of
 * those Claude calls already took the picker past a 180-second ceiling.
 *
 * This resolves the same three kinds for the whole trip at once, with the
 * per-day Claude call removed entirely:
 *
 *  - campsites come from Places, which the pipeline is already calling for
 *    each day to place the overnight itself, so they cost nothing extra;
 *  - stellplatz and free motorhome parking both come from OSM, in a handful
 *    of corridor-wide Overpass requests for the entire trip rather than one
 *    per day (see searchOvernightOsmAlongRoute).
 *
 * OSM does not map wild camping — nobody surveys a field — so the free option
 * offered here is parking a motorhome is explicitly allowed to use, which is
 * the thing that actually has coordinates. Whether a given country lets you
 * sleep in one is prose, not a POI, and stays where it already lives: the
 * per-country free-camping rules in the country guide.
 *
 * Nothing here is allowed to fail the generation. Every source degrades to
 * "no options of that kind for this day", which is the honest answer anyway
 * for a stretch of road with no campsite on it.
 */
export async function resolveOvernightOptions(
  days: DayOvernightQuery[],
): Promise<Map<string, OvernightStopCandidate[]>> {
  const byDay = new Map<string, OvernightStopCandidate[]>()
  if (days.length === 0) return byDay

  const osmPlaces = await searchOvernightOsmAlongRoute(
    days.map((day) => day.near),
  ).catch((error: unknown) => {
    console.warn('Overnight options: OSM lookup failed for the whole route', error)
    return [] as OsmOvernightPlace[]
  })

  for (const day of days) {
    const campsites = await findNearbyCampsites(
      day.near,
      day.country,
      OPTIONS_PER_KIND,
    ).catch((error: unknown) => {
      console.warn(`Overnight options: campsite lookup failed near ${day.key}`, error)
      return [] as OvernightStopCandidate[]
    })

    const fromOsm = (kind: OsmOvernightPlace['kind']) =>
      nearestOsmPlaces(osmPlaces, day.near, kind, OPTIONS_PER_KIND).map((place) =>
        osmPlaceToCandidate(place, day.country),
      )

    byDay.set(day.key, [...campsites, ...fromOsm('stellplatz'), ...fromOsm('wild')])
  }

  return byDay
}

/**
 * Which of a day's options becomes the committed overnight — the point the
 * route is actually driven to, and the pin "Navigate" opens.
 *
 * Something has to be committed: TripDay.overnight is a single point, and
 * every drive leg is measured to it. The traveler's stated preference is
 * stellplatz, so that is what wins where one exists.
 *
 * The fallback to a campsite is not just for "no stellplatz nearby". OSM
 * stellplatz entries are frequently unnamed and carry no indication of
 * whether the site still operates, whereas a Places campsite comes with a
 * rating and a review count. Where the best stellplatz on offer is an
 * anonymous point on a map, a real campsite is the better thing to commit a
 * night of the trip to — the stellplatz is still right there in the options
 * list for anyone who wants it.
 */
export function pickDefaultOvernight(
  options: OvernightStopCandidate[],
): OvernightStopCandidate | null {
  const named = (candidate: OvernightStopCandidate) =>
    !/^unnamed |^motorhome parking$/i.test(candidate.name.trim())

  const stellplatz = options.filter((option) => option.type === 'stellplatz')
  const campsites = options.filter((option) => option.type === 'campsite')

  return (
    stellplatz.find(named) ??
    campsites[0] ??
    stellplatz[0] ??
    // Free parking is offered but never chosen for you: whether you may
    // actually spend the night in one is a question about local signage and
    // national law, not about the pin. See the country's free-camping rules.
    null
  )
}

/**
 * Resolves overnight options for every day of a trip that already exists, and
 * commits each day's default.
 *
 * A separate pass over written days rather than part of resolveSkeletonDay,
 * for two reasons. The corridor OSM query wants every day's location at once,
 * which a sequential per-day resolver cannot offer. And separating it means
 * this is re-runnable on its own: re-resolving where you could sleep touches
 * nothing else about the plan, so it costs one Overpass request and two Places
 * calls per day, with no Claude and no regeneration.
 *
 * Safe to re-run precisely because drive legs are measured town-to-town (see
 * resolveSkeletonDay's own note on nextLocation) — moving the committed
 * overnight within its town does not invalidate any distance already computed.
 */
export async function applyOvernightOptions(
  tripRef: DocumentReference,
): Promise<{ daysResolved: number; optionsWritten: number }> {
  const daysSnap = await tripRef.collection('days').get()
  const days = daysSnap.docs
    .map((doc) => ({ ref: doc.ref, day: doc.data() as TripDay }))
    .sort((a, b) => a.day.index - b.day.index)
  if (days.length === 0) return { daysResolved: 0, optionsWritten: 0 }

  const optionsByDay = await resolveOvernightOptions(
    days.map(({ ref, day }) => ({
      key: ref.id,
      // The town the day is about. `overnight` may already have been moved
      // onto a specific site by an earlier run of this same pass, and
      // re-anchoring on that would let the search drift a little further out
      // of town on every re-run.
      near: day.townAnchor ?? { lat: day.overnight.lat, lng: day.overnight.lng },
      country: day.overnight.country,
    })),
  )

  const writes: PendingWrite[] = []
  let optionsWritten = 0

  for (const { ref, day } of days) {
    const existing = await ref.collection('overnightOptions').get()
    existing.docs.forEach((doc) => writes.push({ op: 'delete', ref: doc.ref }))

    const options = optionsByDay.get(ref.id) ?? []
    for (const option of options) {
      overnightStopCandidateSchema.parse(option)
      writes.push({
        op: 'set',
        ref: ref.collection('overnightOptions').doc(),
        data: option,
      })
    }
    optionsWritten += options.length

    const anchor = day.townAnchor ?? {
      lat: day.overnight.lat,
      lng: day.overnight.lng,
    }
    const picked = pickDefaultOvernight(options)
    writes.push({
      op: 'set',
      ref,
      data: {
        ...day,
        // Remembered so a re-run searches around the town again rather than
        // around wherever the last run decided to sleep.
        townAnchor: anchor,
        overnight: {
          ...day.overnight,
          ...(picked
            ? {
                lat: picked.lat,
                lng: picked.lng,
                campsiteSuggestion: picked.name,
              }
            : { lat: anchor.lat, lng: anchor.lng }),
        },
      },
    })
  }

  await commitInChunks(getFirestore(), writes)
  return { daysResolved: days.length, optionsWritten }
}
