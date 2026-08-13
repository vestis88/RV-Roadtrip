import { getFirestore, type DocumentReference } from 'firebase-admin/firestore'
import { offGridToleranceOf, overnightStopCandidateSchema } from '@rv/shared'
import type {
  LatLng,
  OvernightStopCandidate,
  TripDay,
  TripSettings,
} from '@rv/shared'
import {
  freeCampingPolicy,
  loadFreeCampingRulesByCountry,
} from './countryGuideSections.js'
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
 * That gap did not close when free nights became committable (2026-08-13).
 * What the traveler describes — pulling off somewhere quiet in open country
 * — is precisely what no source maps, and the standing rule that Claude is
 * never asked to invent coordinates applies hardest here: a plausible pin in
 * a field is a night spent driving up a farm track in the dark. So a free
 * night is only ever committed to a lay-by or free motorhome parking area
 * that OSM actually knows about, with the country's rules recorded alongside
 * it. In a right-to-roam country those coordinates are a starting point
 * rather than a fence — the rules the day carries are what say how far off
 * it the traveler may legally go.
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

/** What the day itself contributes to the choice of where it sleeps. */
export interface OvernightChoiceContext {
  /**
   * Whether this country's own researched rules permit sleeping in a free
   * spot at all (see freeCampingPolicy). False also covers "nobody has
   * researched this country yet", which is not permission.
   */
  freeCampingPermitted: boolean
  /**
   * Nights of the off-grid tolerance still unspent when this night starts.
   * 0 means the tanks are due: this night has to be somewhere with
   * facilities.
   */
  offGridNightsRemaining: number
  /** A whole day parked here, rather than one night in passing. */
  restDay: boolean
}

/**
 * Which of a day's options becomes the committed overnight — the point the
 * route is actually driven to, and the pin "Navigate" opens.
 *
 * Something has to be committed: TripDay.overnight is a single point, and
 * every drive leg is measured to it.
 *
 * This used to refuse outright to commit a free night, on the grounds that
 * whether you may sleep in one is a question about signage and national law.
 * The traveler overruled that (2026-08-13) — they are happy to be off grid
 * in open country and equipped for it — so legality became an input instead
 * of a blanket refusal, and a free night is now chosen where three things
 * hold at once:
 *
 *  - the country's own researched rules permit it. Norway and Sweden have a
 *    named right to roam; Germany prohibits it outside designated spots and
 *    Croatia and Italy are stricter still. That is per country, and it is
 *    already researched and cached per country, so the planner reads it
 *    rather than guessing.
 *  - the tanks can take it. This is the constraint that actually binds:
 *    fresh water runs out and grey/black fills up, so a run of free nights
 *    ends after offGridTolerance of them whatever the law says. A serviced
 *    night resets it.
 *  - the day is a drive day. A rest day is a whole day parked in one place —
 *    the day the tanks empty fastest, the day facilities are worth the most,
 *    and the day a stellplatz's short max-stay bites — so rest days go to a
 *    serviced stop even mid-run.
 *
 * The serviced order below is unchanged, and its fallback to a campsite is
 * not just for "no stellplatz nearby": OSM stellplatz entries are frequently
 * unnamed and carry no indication of whether the site still operates,
 * whereas a Places campsite comes with a rating and a review count. Where
 * the best stellplatz on offer is an anonymous point on a map, a real
 * campsite is the better thing to commit a night of the trip to.
 *
 * Both campsites and stellplatz count as servicing the RV. A stellplatz is
 * by definition a motorhome stopover — water and a dump point are what
 * distinguishes one from a car park — and `fee=no` on one does not make it
 * an off-grid night: this budget is about tanks, not about money.
 */
export function pickDefaultOvernight(
  options: OvernightStopCandidate[],
  context: OvernightChoiceContext,
): OvernightStopCandidate | null {
  const named = (candidate: OvernightStopCandidate) =>
    !/^unnamed |^motorhome parking$/i.test(candidate.name.trim())

  const stellplatz = options.filter((option) => option.type === 'stellplatz')
  const campsites = options.filter((option) => option.type === 'campsite')
  const free = context.freeCampingPermitted
    ? options.filter((option) => option.type === 'wild')
    : []

  const offGridNight =
    !context.restDay && context.offGridNightsRemaining > 0 ? free[0] : undefined

  return (
    offGridNight ??
    stellplatz.find(named) ??
    campsites[0] ??
    stellplatz[0] ??
    // Servicing was due (or this is a rest day) and nothing serviced exists
    // near this town. Committing the free spot anyway beats leaving the night
    // on a town-centre intersection, and the caller does not treat it as
    // servicing — the tanks stay due, so the requirement carries into the
    // next day, where there may be a campsite to meet it.
    free[0] ??
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
 *
 * The off-grid budget is why this walks the days in index order rather than
 * resolving each one independently: "after N free nights, service the RV" is
 * a fact about the sequence, so each day's choice depends on what the
 * previous nights turned out to be. Days are sorted by index below for
 * exactly that reason, not for tidiness.
 */
export async function applyOvernightOptions(
  tripRef: DocumentReference,
): Promise<{ daysResolved: number; optionsWritten: number }> {
  const daysSnap = await tripRef.collection('days').get()
  const days = daysSnap.docs
    .map((doc) => ({ ref: doc.ref, day: doc.data() as TripDay }))
    .sort((a, b) => a.day.index - b.day.index)
  if (days.length === 0) return { daysResolved: 0, optionsWritten: 0 }

  const settings = (await tripRef.get()).data()?.settings as
    | TripSettings
    | undefined
  const offGridTolerance = offGridToleranceOf(settings ?? {})

  // One lookup per country the trip crosses, not per day: the rules are
  // researched and cached per country, and a two-month trip through six of
  // them would otherwise read the same six documents sixty times.
  const rulesByCountry = await loadFreeCampingRulesByCountry(
    days.map(({ day }) => day.overnight.country),
  )
  const policyByCountry = new Map(
    [...new Set(days.map(({ day }) => day.overnight.country))].map((country) => [
      country,
      freeCampingPolicy(rulesByCountry.get(country)),
    ]),
  )

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
  /** Free nights committed since the last night with facilities. */
  let offGridNightsSpent = 0

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
    const policy = policyByCountry.get(day.overnight.country) ?? {
      permitted: false,
      rule: null,
    }
    const picked = pickDefaultOvernight(options, {
      freeCampingPermitted: policy.permitted,
      offGridNightsRemaining: Math.max(0, offGridTolerance - offGridNightsSpent),
      restDay: day.type === 'rest',
    })

    // Only a committed campsite or stellplatz empties the tanks. A day left
    // on its town point counts as off grid too: nothing serviced was found
    // near it, so treating it as a service stop would hand the trip a free
    // reset every time a stretch of road came up empty — the one place a
    // wrong guess costs the traveler a full grey tank.
    offGridNightsSpent =
      picked && picked.type !== 'wild' ? 0 : offGridNightsSpent + 1

    // Last run's verdict is dropped before this run's is written: `type` and
    // `freeCampingRule` describe the night picked THIS time, and this pass
    // re-runs. Carrying them over would leave a "free camping is legal here"
    // sentence sitting on a night that is now a campsite.
    const stop = { ...day.overnight }
    delete stop.type
    delete stop.freeCampingRule
    writes.push({
      op: 'set',
      ref,
      data: {
        ...day,
        // Remembered so a re-run searches around the town again rather than
        // around wherever the last run decided to sleep.
        townAnchor: anchor,
        overnight: {
          ...stop,
          ...(picked
            ? {
                lat: picked.lat,
                lng: picked.lng,
                campsiteSuggestion: picked.name,
                type: picked.type,
                // The rule the night was actually committed on, kept with the
                // night rather than only in the country guide — the guide can
                // be re-researched, and this is what the decision was made on.
                ...(picked.type === 'wild' && policy.rule
                  ? { freeCampingRule: policy.rule }
                  : {}),
              }
            : { lat: anchor.lat, lng: anchor.lng }),
        },
      },
    })
  }

  await commitInChunks(getFirestore(), writes)
  return { daysResolved: days.length, optionsWritten }
}
